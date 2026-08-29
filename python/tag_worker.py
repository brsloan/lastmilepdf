"""
tag_worker.py

Long-running sidecar process spawned by Electron's main process (see
../main.js). Speaks newline-delimited JSON over stdin/stdout:

    request:  {"id": 1, "cmd": "open", "path": "/some/file.pdf"}
    response: {"id": 1, "result": {...}}
              or
              {"id": 1, "error": "message"}

Why a sidecar instead of a Node-native library: pikepdf (a wrapper around
qpdf) is the most reliable way to read and mutate a PDF's logical structure
tree (the /StructTreeRoot object graph that PDF/UA accessibility tags live
in), and it's Python-only. There is no equivalent low-level structure-tree
API in the Node ecosystem, so we keep one Python process alive for the life
of the app and talk to it over stdio rather than shelling out per-call
(which would mean re-parsing the PDF every time).

Scope / known limitations (read this before extending):
  - Content leaves (a bare MCID, or an /MCR or /OBJR dict) can be reordered
    and reparented via `reorder`/`reorder_many` the same as StructElems, but
    only within the same page: a bare MCID has no /Pg of its own, so its
    page is whatever its containing StructElem resolves to, and moving one
    under a StructElem on a *different* page would silently mislabel which
    page's content stream it lives in. /MCR and /OBJR carry their own /Pg,
    so they're free to move across pages. See `_is_container` and the
    page check in `reorder_node`/`reorder_many`. Content leaves have no
    editable attributes and can never themselves be a drop target.
  - Every mutating call rebuilds and returns the *entire* tree rather than
    patching it incrementally. This trades some efficiency for correctness:
    node ids are just a fresh depth-first counter assigned on each rebuild,
    so the renderer can't ever hold a stale id that silently points at the
    wrong node after an edit.
  - RoleMap, ParentTree, and ClassMap (optional StructTreeRoot extras) are
    not read or written, with one exception: figure_from_rect() both reads
    and writes /ParentTree, since tagging an image via /OBJR requires a
    ParentTree entry the same way a page's /StructParents array does for
    bare MCIDs. See that section for the /Kids (multi-level number tree)
    limitation this comes with.
  - Every command here mutates the struct tree only - except
    figure_from_rect(), which also *reads* (never writes) a page's content
    stream, to recover where image XObjects are actually placed. See its
    section for why and how.
  - Undo/redo works by snapshotting the *entire* pikepdf.Pdf (serialized to
    bytes) before each mutation, rather than recording inverse edits. Simple
    and correct by construction, at the cost of an O(document size) copy per
    edit - acceptable given every edit already rebuilds the whole tree, but
    worth knowing if this ever needs to scale to very large PDFs edited
    rapidly. `MAX_UNDO_DEPTH` bounds how many snapshots we hold onto.
"""

import io
import json
import re
import sys
import uuid

MAX_UNDO_DEPTH = 50

try:
    import pikepdf
except ImportError:
    sys.stdout.write(json.dumps({
        "id": None,
        "error": (
            "The 'pikepdf' package is not installed in this Python "
            "environment. Run: pip install -r python/requirements.txt"
        ),
    }) + "\n")
    sys.stdout.flush()
    sys.exit(1)


# doc_id -> {"pdf": pikepdf.Pdf, "elements": {node_id: Dictionary}, "parent_map": {node_id: parent_id}, "counter": int}
documents = {}


# --- helpers ---------------------------------------------------------------

def _next_id(doc):
    doc["counter"] += 1
    return f"n{doc['counter']}"


def _as_leaf_mcid(kid):
    """If `kid` is a bare marked-content-id integer (not a Dictionary/Array/
    etc.), return it as a Python int. Otherwise return None."""
    if isinstance(kid, (pikepdf.Dictionary, pikepdf.Array, pikepdf.String, pikepdf.Name)):
        return None
    try:
        return int(kid)
    except (TypeError, ValueError):
        return None


def _iter_kids(struct_obj):
    """Normalize /K into a flat Python list. /K may be absent, a single
    Dictionary, a single bare integer, or an Array mixing all of those."""
    kids = struct_obj.get("/K")
    if kids is None:
        return []
    if isinstance(kids, pikepdf.Array):
        return list(kids)
    return [kids]


def _get_string(obj, key):
    if key not in obj:
        return None
    try:
        return str(obj[key])
    except Exception:
        return None


def _set_or_clear_string(obj, key, value):
    if value:
        obj[key] = pikepdf.String(value)
    elif key in obj:
        del obj[key]


def _get_doc_info(doc):
    """Title/Author out of the PDF's document information dictionary
    (trailer /Info), read directly off the trailer rather than through
    pikepdf's `Pdf.docinfo` property - that property auto-vivifies an /Info
    dict on first access, which would dirty documents that don't have one
    just from opening them or selecting the /Document tag."""
    info = doc["pdf"].trailer.get("/Info")
    if not isinstance(info, pikepdf.Dictionary):
        return {"title": None, "author": None}
    return {"title": _get_string(info, "/Title"), "author": _get_string(info, "/Author")}


def update_doc_info(doc_id, changes):
    """Sets Title/Author on the PDF's document information dictionary - the
    Tag Properties panel swaps in these fields (in place of Alt/Actual Text)
    when the /Document tag is selected, since that struct element doesn't
    carry meaningful accessibility text of its own.

    Also mirrors the change into XMP (dc:title/dc:creator): Acrobat's
    Document Properties dialog reads Title/Author from XMP whenever an XMP
    stream is present, and ignores /Info entirely in that case, so writing
    only the legacy /Info dict left Acrobat showing stale values."""
    doc = documents[doc_id]
    _push_undo_snapshot(doc)
    info = doc["pdf"].docinfo
    if "title" in changes:
        _set_or_clear_string(info, "/Title", changes["title"])
    if "author" in changes:
        _set_or_clear_string(info, "/Author", changes["author"])
    with doc["pdf"].open_metadata() as meta:
        meta.load_from_docinfo(info, delete_missing=True)
    return {"docInfo": _get_doc_info(doc), **_undo_state(doc)}


def _find_table_attr_obj(struct_obj):
    """The /Table-owned attribute dict inside `struct_obj`'s /A entry, if
    any. /A may be absent, a single attribute dict, or an array mixing
    attribute dicts from different owners (e.g. /Layout alongside /Table) -
    entries that aren't a dict, or whose /O isn't /Table, are skipped."""
    a = struct_obj.get("/A")
    if isinstance(a, pikepdf.Dictionary):
        candidates = [a]
    elif isinstance(a, pikepdf.Array):
        candidates = list(a)
    else:
        return None
    for item in candidates:
        if isinstance(item, pikepdf.Dictionary) and str(item.get("/O", "")).lstrip("/") == "Table":
            return item
    return None


def _find_layout_bbox(struct_obj):
    """The /BBox off `struct_obj`'s /Layout-owned attribute entry (PDF
    32000-1 14.8.5.4.3), as a 4-float [x0, y0, x1, y1] in the page's default
    user space, or None if there isn't one. Only figure_from_rect()'s "bbox"
    strategy writes this today (a Figure with no isolable marked content -
    see its section), but any /Layout /BBox round-trips here the same way,
    same /A-may-be-a-single-dict-or-an-array handling as
    _find_table_attr_obj."""
    a = struct_obj.get("/A")
    if isinstance(a, pikepdf.Dictionary):
        candidates = [a]
    elif isinstance(a, pikepdf.Array):
        candidates = list(a)
    else:
        return None
    for item in candidates:
        if not isinstance(item, pikepdf.Dictionary):
            continue
        if str(item.get("/O", "")).lstrip("/") != "Layout" or "/BBox" not in item:
            continue
        try:
            return [float(v) for v in item["/BBox"]]
        except (TypeError, ValueError):
            return None
    return None


def _get_table_attrs(struct_obj):
    """Scope/ColSpan/RowSpan read off `struct_obj`'s /Table attribute
    object, each None if unset or unparseable. Backs the tag properties
    panel's TH attributes section."""
    attr = _find_table_attr_obj(struct_obj)
    if attr is None:
        return {"scope": None, "colSpan": None, "rowSpan": None}

    scope = None
    if "/Scope" in attr:
        try:
            scope = str(attr["/Scope"]).lstrip("/")
        except Exception:
            scope = None

    def _int_or_none(key):
        if key not in attr:
            return None
        try:
            return int(attr[key])
        except (TypeError, ValueError):
            return None

    return {"scope": scope, "colSpan": _int_or_none("/ColSpan"), "rowSpan": _int_or_none("/RowSpan")}


def _ensure_table_attr_obj(doc, struct_obj):
    """Like _find_table_attr_obj, but creates (and attaches to /A) a fresh
    Table attribute dict if none exists yet - folded in alongside whatever
    /A already held (a lone other-owner dict becomes a 2-element array; an
    existing array just gets the new dict appended)."""
    existing = _find_table_attr_obj(struct_obj)
    if existing is not None:
        return existing
    new_attr = doc["pdf"].make_indirect(pikepdf.Dictionary({"/O": pikepdf.Name("/Table")}))
    a = struct_obj.get("/A")
    if a is None:
        struct_obj["/A"] = new_attr
    elif isinstance(a, pikepdf.Array):
        struct_obj["/A"] = pikepdf.Array(list(a) + [new_attr])
    else:
        struct_obj["/A"] = pikepdf.Array([a, new_attr])
    return new_attr


def _prune_table_attr(struct_obj):
    """Removes the /Table-owned attribute dict from /A once nothing but /O
    is left in it (e.g. after clearing Scope/ColSpan/RowSpan back to
    unset), and drops /A entirely if that was its only attribute object -
    mirrors how _set_or_clear_string() removes an emptied key rather than
    leaving a stray dict/array behind."""
    attr = _find_table_attr_obj(struct_obj)
    if attr is None or len(attr) > 1:
        return
    a = struct_obj["/A"]
    if isinstance(a, pikepdf.Array):
        remaining = [item for item in a if not _same_object(item, attr)]
        if remaining:
            struct_obj["/A"] = remaining[0] if len(remaining) == 1 else pikepdf.Array(remaining)
            return
    del struct_obj["/A"]


def _apply_table_attr_changes(doc, elem, changes):
    """Applies `scope`/`colSpan`/`rowSpan` from `changes` (each an already-
    trimmed string; '' clears the attribute) onto elem's /Table-owned
    attribute object, creating one only if there's actually something to
    write, and pruning it away again if every field ends up cleared. Backs
    the tag properties panel's TH attributes section."""
    if not any(key in changes for key in ("scope", "colSpan", "rowSpan")):
        return

    attr = [None]  # boxed so the nested closure can lazily create-and-cache it

    def get_or_create_attr():
        if attr[0] is None:
            attr[0] = _ensure_table_attr_obj(doc, elem)
        return attr[0]

    if "scope" in changes:
        value = changes["scope"]
        if value:
            get_or_create_attr()["/Scope"] = pikepdf.Name("/" + value)
        else:
            existing = _find_table_attr_obj(elem)
            if existing is not None and "/Scope" in existing:
                del existing["/Scope"]

    for key, pdf_key in (("colSpan", "/ColSpan"), ("rowSpan", "/RowSpan")):
        if key not in changes:
            continue
        value = changes[key]
        if value:
            try:
                num = int(value)
            except (TypeError, ValueError):
                raise ValueError(f"{key} must be a whole number")
            if num < 1:
                raise ValueError(f"{key} must be at least 1")
            get_or_create_attr()[pdf_key] = num
        else:
            existing = _find_table_attr_obj(elem)
            if existing is not None and pdf_key in existing:
                del existing[pdf_key]

    _prune_table_attr(elem)


def _same_object(a, b):
    """Identity comparison that works for indirect PDF objects, where two
    Python-side wrapper instances can refer to the same underlying object."""
    a_indirect = getattr(a, "is_indirect", False)
    b_indirect = getattr(b, "is_indirect", False)
    if a_indirect and b_indirect:
        return a.objgen == b.objgen
    try:
        return a == b
    except Exception:
        return a is b


def _remove_kid(parent_obj, node_obj):
    kids = parent_obj.get("/K")
    if kids is None:
        return
    if isinstance(kids, pikepdf.Array):
        remaining = [k for k in kids if not _same_object(k, node_obj)]
        if len(remaining) == 0:
            del parent_obj["/K"]
        else:
            parent_obj["/K"] = pikepdf.Array(remaining)
    elif _same_object(kids, node_obj):
        del parent_obj["/K"]


def _insert_kid(parent_obj, node_obj, index):
    kids = parent_obj.get("/K")
    if kids is None:
        items = []
    elif isinstance(kids, pikepdf.Array):
        items = list(kids)
    else:
        items = [kids]
    index = max(0, min(index, len(items)))
    items.insert(index, node_obj)
    parent_obj["/K"] = pikepdf.Array(items)


def _kid_index(struct_obj, kid_obj):
    """Position of `kid_obj` among struct_obj's /K, by the same identity/
    equality rule _remove_kid uses (so "found here" always agrees with
    "removable from here"). -1 if not present."""
    for i, k in enumerate(_iter_kids(struct_obj)):
        if _same_object(k, kid_obj):
            return i
    return -1


def _top_level_selection(doc, node_ids):
    """Filters `node_ids` down to those that aren't a descendant of another
    id in the same list - for use before an operation that removes or
    replaces a whole subtree, so a covered descendant isn't then processed
    a second time against a parent link that operation already invalidated."""
    id_set = set(node_ids)

    def _has_selected_ancestor(node_id):
        walker = doc["parent_map"].get(node_id)
        while walker is not None:
            if walker in id_set:
                return True
            walker = doc["parent_map"].get(walker)
        return False

    return [nid for nid in node_ids if not _has_selected_ancestor(nid)]


def _wrap_leaf(doc, leaf_node_id, role):
    """Wraps the content/object-ref leaf at `leaf_node_id` in a brand-new
    struct element with role `role`, inserted at the leaf's current position
    within its parent (replacing the bare leaf there). Used wherever a
    tag-tree role shortcut (H1-H6, P, LI) targets a leaf, which - unlike a
    struct element - has no /S of its own to relabel in place."""
    parent_id = doc["parent_map"][leaf_node_id]
    parent_obj = doc["elements"][parent_id]
    leaf_obj = doc["elements"][leaf_node_id]

    index = _kid_index(parent_obj, leaf_obj)
    if index == -1:
        raise ValueError("Could not locate content leaf in its parent")

    new_elem = doc["pdf"].make_indirect(pikepdf.Dictionary({
        "/Type": pikepdf.Name("/StructElem"),
        "/S": pikepdf.Name("/" + role),
        "/P": parent_obj,
    }))
    # A bare MCID (or an /MCR/OBJR with no /Pg of its own) resolves its page
    # by inheriting from its nearest ancestor - set it explicitly here so
    # the leaf keeps pointing at the same page regardless of where in the
    # tree its new wrapper ends up (see the module docstring on /Pg
    # inheritance).
    page_index = doc["node_pages"].get(leaf_node_id)
    if page_index is not None:
        new_elem["/Pg"] = doc["pdf"].pages[page_index].obj
    new_elem["/K"] = leaf_obj

    _remove_kid(parent_obj, leaf_obj)
    _insert_kid(parent_obj, new_elem, index)
    return new_elem


def set_role_or_wrap(doc_id, node_ids, role):
    """For each selected node: relabels its /S to `role` in place if it's
    already a struct element, or wraps it in a brand-new struct element with
    that role if it's a content/object-ref leaf. Backs the tag tree's H1-H6
    and 'I' (List Item) shortcuts."""
    doc = documents[doc_id]
    if not node_ids:
        raise ValueError("No tags selected")
    for node_id in node_ids:
        if node_id == "root":
            raise ValueError("Cannot change the role of the document root")
        if node_id not in doc["elements"]:
            raise ValueError(f"Unknown node id: {node_id}")

    _push_undo_snapshot(doc)
    for node_id in node_ids:
        if doc["node_kind"].get(node_id) == "element":
            doc["elements"][node_id]["/S"] = pikepdf.Name("/" + role)
        else:
            _wrap_leaf(doc, node_id, role)

    return {"tree": _rebuild_registry(doc_id), **_undo_state(doc)}


# Roles the 'P' shortcut's flatten dissolves rather than preserves, when
# encountered anywhere in a List/Span/Div's subtree - see _paragraphize().
_TRANSPARENT_ROLES = ("L", "Span", "Div", "LI", "Lbl", "LBody")


def _direct_child_ids(doc, node_id):
    """Direct children of node_id, in document order - relies on
    doc["parent_map"] preserving insertion order from the last
    _rebuild_registry, which walks kids left-to-right (see _walk)."""
    return [cid for cid, pid in doc["parent_map"].items() if pid == node_id]


def _make_paragraph(doc, leaf_ids):
    """A new, not-yet-attached /P struct element grouping every leaf in
    `leaf_ids` (already in document order) under one /K - one new element
    per *run* of leaves that belonged together, never one per leaf. /Pg is
    taken from the first leaf; leaves grouped by _paragraphize() always come
    from the same direct-children run (or, for an LI's Lbl+LBody merge,
    from one list item), so in practice they always share a page."""
    new_p = doc["pdf"].make_indirect(pikepdf.Dictionary({
        "/Type": pikepdf.Name("/StructElem"),
        "/S": pikepdf.Name("/P"),
    }))
    page_index = doc["node_pages"].get(leaf_ids[0])
    if page_index is not None:
        new_p["/Pg"] = doc["pdf"].pages[page_index].obj
    leaf_objs = [doc["elements"][lid] for lid in leaf_ids]
    new_p["/K"] = leaf_objs[0] if len(leaf_objs) == 1 else pikepdf.Array(leaf_objs)
    return new_p


def _paragraphize(doc, node_id):
    """What `node_id` dissolves into when the 'P' shortcut flattens an
    ancestor List/Span/Div: a flat, ordered list of struct-element objects
    (not yet attached anywhere) to splice in in its place. A tag whose role
    isn't in _TRANSPARENT_ROLES is left completely untouched and passed
    through as a single opaque unit - recursion stops there. Everything
    else is dissolved (recursively, arbitrarily deep) by
    _paragraphize_children(), except LI, which _paragraphize_list_item()
    handles specially."""
    struct_obj = doc["elements"][node_id]
    role = str(struct_obj.get("/S", "")).lstrip("/")

    if role == "LI":
        return _paragraphize_list_item(doc, node_id)
    if role not in _TRANSPARENT_ROLES:
        return [struct_obj]
    return _paragraphize_children(doc, node_id)


def _paragraphize_children(doc, node_id):
    """Generic dissolve for a transparent container: walks its direct
    children in order, grouping each maximal run of consecutive direct
    content leaves into one new /P (a run broken by an intervening
    structural child becomes two paragraphs, not one - see the module's P
    shortcut docs), and recursively dissolving any structural child in
    place via _paragraphize()."""
    output = []
    pending_leaves = []

    def flush():
        if pending_leaves:
            output.append(_make_paragraph(doc, pending_leaves))
            pending_leaves.clear()

    for child_id in _direct_child_ids(doc, node_id):
        if doc["node_kind"].get(child_id) == "element":
            flush()
            output.extend(_paragraphize(doc, child_id))
        else:
            pending_leaves.append(child_id)
    flush()
    return output


def _leaves_through_spans(doc, node_id):
    """Every content leaf under `node_id`, descending through nested Span
    children (an inline role with no semantics of its own - a Lbl/LBody's
    text is routinely wrapped in one for language/style runs) as if they
    weren't there. Returns None instead if a child of any other structural
    role turns up, signaling the caller should treat this subtree as too
    structured to merge into a single leaf run."""
    leaves = []
    for child_id in _direct_child_ids(doc, node_id):
        if doc["node_kind"].get(child_id) != "element":
            leaves.append(child_id)
            continue
        child_role = str(doc["elements"][child_id].get("/S", "")).lstrip("/")
        if child_role != "Span":
            return None
        nested = _leaves_through_spans(doc, child_id)
        if nested is None:
            return None
        leaves.extend(nested)
    return leaves


def _paragraphize_list_item(doc, node_id):
    """Dissolve for an LI: every content leaf inside a Lbl and/or LBody
    child - including ones tucked inside a nested Span, per
    _leaves_through_spans() - is combined into one shared /P (they're one
    list item's label and body - flattening them into two disconnected
    paragraphs would lose that). A Lbl/LBody with any *other* nested
    structure falls back to being dissolved on its own via _paragraphize(),
    same as any other structural child, rather than risk merging things out
    of order. Anything else directly under the LI (a bare leaf, or non-Lbl/
    LBody structural content e.g. a nested sub-list) is handled the same
    way _paragraphize_children() would."""
    output = []
    pending_leaves = []
    combined_leaves = []

    def flush_pending():
        if pending_leaves:
            output.append(_make_paragraph(doc, pending_leaves))
            pending_leaves.clear()

    def flush_combined():
        if combined_leaves:
            output.append(_make_paragraph(doc, combined_leaves))
            combined_leaves.clear()

    for child_id in _direct_child_ids(doc, node_id):
        if doc["node_kind"].get(child_id) != "element":
            pending_leaves.append(child_id)
            continue

        child_role = str(doc["elements"][child_id].get("/S", "")).lstrip("/")
        leaves = _leaves_through_spans(doc, child_id) if child_role in ("Lbl", "LBody") else None
        if leaves is not None:
            flush_pending()
            combined_leaves.extend(leaves)
        else:
            flush_pending()
            flush_combined()
            output.extend(_paragraphize(doc, child_id))

    flush_pending()
    flush_combined()
    return output


def _flatten_container_to_paragraphs(doc, node_id):
    """Replaces the List/Span/Div struct element at `node_id` with the
    fully flattened contents of its whole subtree (see _paragraphize),
    spliced into its own parent in its place. The container itself is
    always discarded."""
    parent_id = doc["parent_map"].get(node_id)
    if parent_id is None:
        raise ValueError("Cannot flatten the document root")
    parent_obj = doc["elements"][parent_id]
    node_obj = doc["elements"][node_id]

    index = _kid_index(parent_obj, node_obj)
    if index == -1:
        raise ValueError("Could not locate tag in its parent")

    replacements = _paragraphize(doc, node_id)
    for repl in replacements:
        repl["/P"] = parent_obj

    _remove_kid(parent_obj, node_obj)
    for offset, repl in enumerate(replacements):
        _insert_kid(parent_obj, repl, index + offset)


def convert_to_paragraph(doc_id, node_ids):
    """Converts each selected tag to a Paragraph. A List/Span/Div is instead
    flattened (see _flatten_container_to_paragraphs) rather than simply
    relabeled, since turning a list/wrapper's own role into /P while leaving
    its List-Item/inline kids nested beneath it wouldn't make it an actual
    paragraph. Anything else - including a content/object-ref leaf - is
    set-or-wrapped to /P the same way set_role_or_wrap() handles H1-H6/LI.
    Backs the tag tree's 'P' shortcut."""
    doc = documents[doc_id]
    if not node_ids:
        raise ValueError("No tags selected")
    for node_id in node_ids:
        if node_id == "root":
            raise ValueError("Cannot convert the document root")
        if node_id not in doc["elements"]:
            raise ValueError(f"Unknown node id: {node_id}")

    top_level = _top_level_selection(doc, node_ids)

    _push_undo_snapshot(doc)
    for node_id in top_level:
        if doc["node_kind"].get(node_id) == "element":
            role = str(doc["elements"][node_id].get("/S", "")).lstrip("/")
            if role in ("L", "Span", "Div"):
                _flatten_container_to_paragraphs(doc, node_id)
            else:
                doc["elements"][node_id]["/S"] = pikepdf.Name("/P")
        else:
            _wrap_leaf(doc, node_id, "P")

    return {"tree": _rebuild_registry(doc_id), **_undo_state(doc)}


def _group_into_container(doc_id, node_ids, container_role, item_role, preserved_roles, cant_group_msg):
    """Shared shape behind the 'L'/'T'/'R' shortcuts: groups the selected
    tags into a newly created container struct element (List/Table/TR).
    Each selected node becomes a child with role `item_role` - a struct
    element is relabeled in place (unless its current role is already in
    `preserved_roles`, in which case it's left untouched); a content/
    object-ref leaf is wrapped in a brand-new element with role `item_role`,
    same as set_role_or_wrap() does for H1-H6/'I' (a leaf has no role of its
    own, so it's never eligible for `preserved_roles`). The container lands
    at the position the earliest-selected item occupied. Every selected node
    must currently share the same parent - there'd be no single
    well-defined "where the first item was" otherwise."""
    doc = documents[doc_id]
    if not node_ids:
        raise ValueError("No tags selected")
    for node_id in node_ids:
        if node_id == "root":
            raise ValueError("Cannot group the document root")
        if node_id not in doc["elements"]:
            raise ValueError(f"Unknown node id: {node_id}")

    parent_ids = {doc["parent_map"].get(nid) for nid in node_ids}
    if len(parent_ids) != 1 or None in parent_ids:
        raise ValueError(cant_group_msg)
    parent_id = next(iter(parent_ids))
    parent_obj = doc["elements"][parent_id]

    # Document order among the selected nodes, as they currently sit among
    # their shared parent's kids - see _top_level_selection for why this
    # parent_map scan preserves kid order.
    node_id_set = set(node_ids)
    ordered_ids = [cid for cid, pid in doc["parent_map"].items() if pid == parent_id and cid in node_id_set]

    leaf_objs = [doc["elements"][nid] for nid in ordered_ids]
    first_index = min(_kid_index(parent_obj, obj) for obj in leaf_objs)
    if first_index == -1:
        raise ValueError("Could not locate selected tags in their parent")

    _push_undo_snapshot(doc)

    item_dicts = []
    for node_id in ordered_ids:
        if doc["node_kind"].get(node_id) == "element":
            elem = doc["elements"][node_id]
            _remove_kid(parent_obj, elem)
            role = str(elem.get("/S", "")).lstrip("/")
            if role not in preserved_roles:
                elem["/S"] = pikepdf.Name("/" + item_role)
            item_dicts.append(elem)
        else:
            leaf_obj = doc["elements"][node_id]
            _remove_kid(parent_obj, leaf_obj)
            item = doc["pdf"].make_indirect(pikepdf.Dictionary({
                "/Type": pikepdf.Name("/StructElem"),
                "/S": pikepdf.Name("/" + item_role),
            }))
            page_index = doc["node_pages"].get(node_id)
            if page_index is not None:
                item["/Pg"] = doc["pdf"].pages[page_index].obj
            item["/K"] = leaf_obj
            item_dicts.append(item)

    new_container = doc["pdf"].make_indirect(pikepdf.Dictionary({
        "/Type": pikepdf.Name("/StructElem"),
        "/S": pikepdf.Name("/" + container_role),
        "/P": parent_obj,
    }))
    for item in item_dicts:
        item["/P"] = new_container
    new_container["/K"] = pikepdf.Array(item_dicts)

    _insert_kid(parent_obj, new_container, first_index)

    return {"tree": _rebuild_registry(doc_id), **_undo_state(doc)}


def make_list(doc_id, node_ids):
    """Groups the selected tags into a newly created List: each one becomes
    an LI regardless of its prior role. Backs the tag tree's 'L' shortcut -
    see _group_into_container for the shared mechanics."""
    return _group_into_container(
        doc_id, node_ids, "L", "LI", frozenset(),
        "Can't group into a list: selected tags don't share a parent.",
    )


def make_table(doc_id, node_ids):
    """Groups the selected tags into a newly created Table: each one becomes
    a TD, except a TH or TR, which is left as-is. Backs the tag tree's 'T'
    shortcut - see _group_into_container for the shared mechanics."""
    return _group_into_container(
        doc_id, node_ids, "Table", "TD", {"TH", "TR"},
        "Can't group into a table: selected tags don't share a parent.",
    )


def make_tr(doc_id, node_ids):
    """Groups the selected tags into a newly created TR (table row): each
    one becomes a TD, except a TH, which is left as-is. Backs the tag tree's
    'R' shortcut - see _group_into_container for the shared mechanics."""
    return _group_into_container(
        doc_id, node_ids, "TR", "TD", {"TH"},
        "Can't group into a table row: selected tags don't share a parent.",
    )


def _snapshot_bytes(pdf):
    buf = io.BytesIO()
    pdf.save(buf)
    return buf.getvalue()


def _undo_state(doc):
    return {"canUndo": len(doc["undo_stack"]) > 0, "canRedo": len(doc["redo_stack"]) > 0}


def _push_undo_snapshot(doc):
    """Call before mutating `doc["pdf"]`, once validation has passed - a
    new edit always clears the redo stack, same as any standard editor."""
    doc["undo_stack"].append(_snapshot_bytes(doc["pdf"]))
    if len(doc["undo_stack"]) > MAX_UNDO_DEPTH:
        doc["undo_stack"].pop(0)
    doc["redo_stack"].clear()


def _resolve_objref_subtype(kid):
    """For an /OBJR dict, resolve the /Subtype of the object it points at
    (e.g. /Image or /Form for an XObject, /Link or /Widget for an
    annotation), stripped of its leading slash. None if /Obj is missing,
    unresolvable, or has no /Subtype."""
    try:
        target = kid.get("/Obj")
    except Exception:
        return None
    # An Image XObject is a stream (pixel data plus a dict of keys), not a
    # plain Dictionary - pikepdf.Stream isn't a subclass of pikepdf.
    # Dictionary, so it needs checking here too, or every /OBJR pointing at
    # an image (including ones figure_from_rect() creates) resolves to no
    # subtype at all.
    if not isinstance(target, (pikepdf.Dictionary, pikepdf.Stream)) or "/Subtype" not in target:
        return None
    try:
        subtype = str(target["/Subtype"])
    except Exception:
        return None
    return subtype[1:] if subtype.startswith("/") else subtype


def _resolve_page_index(doc, page_obj):
    """Map a /Pg reference (an indirect Page dictionary) to its 0-based
    index in the document's page list, or None if it can't be resolved
    (e.g. missing, or pointing at a page that no longer exists)."""
    if page_obj is None:
        return None
    try:
        objgen = page_obj.objgen
    except AttributeError:
        return None
    return doc["page_index_by_objgen"].get(objgen)


def _walk(doc, struct_obj, node_id, inherited_page=None):
    role = None
    if "/S" in struct_obj:
        role = str(struct_obj["/S"]).lstrip("/")

    # /Pg (the page a struct element's content lives on) is inheritable:
    # if this element doesn't set it, it takes its nearest ancestor's page.
    # Needed so the renderer can find and highlight a tag's marked content
    # on the PDF preview.
    own_page = inherited_page
    resolved = _resolve_page_index(doc, struct_obj.get("/Pg"))
    if resolved is not None:
        own_page = resolved

    # Track every element's resolved page and kind alongside `elements`/
    # `parent_map`, so reorder can tell a container from a content leaf and
    # (for bare-MCID leaves specifically) refuse a cross-page move - see the
    # module docstring.
    doc["node_pages"][node_id] = own_page
    doc["node_kind"][node_id] = "root" if node_id == "root" else "element"

    table_attrs = _get_table_attrs(struct_obj)
    node = {
        "id": node_id,
        "type": "root" if node_id == "root" else "element",
        "role": role,
        "alt": _get_string(struct_obj, "/Alt"),
        "actualText": _get_string(struct_obj, "/ActualText"),
        "lang": _get_string(struct_obj, "/Lang"),
        "scope": table_attrs["scope"],
        "colSpan": table_attrs["colSpan"],
        "rowSpan": table_attrs["rowSpan"],
        "bbox": _find_layout_bbox(struct_obj),
        "page": own_page,
        "children": [],
    }

    for kid in _iter_kids(struct_obj):
        mcid = _as_leaf_mcid(kid)
        if mcid is not None:
            # A bare MCID has no dict of its own to carry /Pg, so it always
            # uses the page established by its containing struct element.
            child_id = _next_id(doc)
            doc["elements"][child_id] = mcid
            doc["parent_map"][child_id] = node_id
            doc["node_pages"][child_id] = own_page
            doc["node_kind"][child_id] = "content-int"
            node["children"].append({
                "id": child_id, "type": "content", "role": None,
                "mcid": mcid, "page": own_page, "children": [],
            })
            continue

        if isinstance(kid, pikepdf.Dictionary) and "/S" in kid:
            child_id = _next_id(doc)
            doc["elements"][child_id] = kid
            doc["parent_map"][child_id] = node_id
            node["children"].append(_walk(doc, kid, child_id, own_page))
        else:
            # /MCR (marked-content reference) or /OBJR (object reference,
            # e.g. an annotation) - a leaf we can display but not edit here.
            kid_type = str(kid.get("/Type")) if isinstance(kid, pikepdf.Dictionary) else None
            mcid_val = None
            if isinstance(kid, pikepdf.Dictionary) and "/MCID" in kid:
                try:
                    mcid_val = int(kid["/MCID"])
                except (TypeError, ValueError):
                    mcid_val = None
            kid_page = own_page
            if isinstance(kid, pikepdf.Dictionary):
                # An /MCR may target a different page than its containing
                # element (e.g. content split across a page boundary).
                resolved_kid_page = _resolve_page_index(doc, kid.get("/Pg"))
                if resolved_kid_page is not None:
                    kid_page = resolved_kid_page
            is_objref = kid_type == "/OBJR"
            child_id = _next_id(doc)
            doc["elements"][child_id] = kid
            doc["parent_map"][child_id] = node_id
            doc["node_pages"][child_id] = kid_page
            doc["node_kind"][child_id] = "content-dict"
            node["children"].append({
                "id": child_id,
                "type": "object-ref" if is_objref else "content",
                "role": None,
                "mcid": mcid_val,
                "page": kid_page,
                "objType": _resolve_objref_subtype(kid) if is_objref else None,
                "children": [],
            })

    return node


def _rebuild_registry(doc_id):
    doc = documents[doc_id]
    doc["elements"] = {}
    doc["parent_map"] = {}
    doc["node_pages"] = {}
    doc["node_kind"] = {}
    doc["counter"] = 0
    struct_root = doc["pdf"].Root["/StructTreeRoot"]
    doc["elements"]["root"] = struct_root
    return _walk(doc, struct_root, "root")


# --- outline (bookmarks) ----------------------------------------------
#
# Separate object graph from the tag tree above (/Outlines vs
# /StructTreeRoot), backed by pikepdf's own high-level Outline/OutlineItem
# API rather than the raw-Dictionary walk _walk() does - pikepdf already
# models an outline as an arbitrary-depth tree of OutlineItem.children,
# which is exactly the shape Acrobat-style nested bookmarks need. Like the
# tag tree, ids ("b1", "b2", ...) are a fresh depth-first counter assigned
# on every read, not persisted identity - see the module docstring's note
# on why the tag tree does the same.

def _outline_item_dest_array(item):
    """The explicit-destination Array behind `item` (a [pageref, ...] as PDF
    12.3.2.2 defines it), from either item.destination directly or, when the
    item instead uses a /GoTo action, that action's /D - a common
    alternative encoding for the exact same "jump to this page" bookmark.
    None if neither is present/resolvable (e.g. a URI action, or a named
    destination this editor doesn't resolve)."""
    dest = item.destination
    if dest is not None:
        return dest
    if item.action is not None and str(item.action.get("/S", "")).lstrip("/") == "GoTo":
        return item.action.get("/D")
    return None


def _outline_item_page(doc, item):
    """0-based page index `item` targets, or None if it has no resolvable
    page destination. A freshly created (not yet saved) item's destination
    is still the plain page-number int it was constructed with - see
    generate_bookmarks(); an item loaded from an existing PDF instead has an
    already-resolved [pageref, ...] Array."""
    dest = _outline_item_dest_array(item)
    if dest is None:
        return None
    if isinstance(dest, int):
        return dest
    if isinstance(dest, pikepdf.Array) and len(dest) > 0:
        return _resolve_page_index(doc, dest[0])
    return None


def _outline_item_top(doc, item):
    """The page-space y-coordinate `item`'s destination scrolls to (matching
    the units/orientation renderer.js's computeHeadingTop() computes them
    in), or None if its fit style doesn't encode a vertical position at all
    (e.g. plain /Fit or /FitB, which just show the whole page). Mirrors
    _outline_item_page()'s handling of the same dest array - see
    _outline_item_dest_array() - but reads the fit-style-dependent "top"
    slot instead of the leading page ref."""
    dest = _outline_item_dest_array(item)
    if not isinstance(dest, pikepdf.Array) or len(dest) < 3:
        return None
    location = str(dest[1])
    try:
        if location == "/XYZ" and len(dest) > 3:
            top = dest[3]
        elif location in ("/FitH", "/FitBH"):
            top = dest[2]
        elif location == "/FitR" and len(dest) > 5:
            top = dest[5]
        else:
            return None
        return float(top)
    except (TypeError, ValueError):
        return None


def _walk_outline(doc, items, counter, id_map=None):
    """Depth-first JSON tree for `items` (an Outline's .root, or an
    OutlineItem's .children), assigning each item a fresh "bN" id as it
    goes. If `id_map` is given, every assigned id is also recorded there as
    id -> the live OutlineItem object, for _locate_outline_item() to look up
    by id later in the *same* open_outline() session - ids aren't stored
    identity, just a reproducible position, so a lookup is only valid
    against a walk of the same not-yet-saved item objects."""
    result = []
    for item in items:
        counter[0] += 1
        node_id = f"b{counter[0]}"
        if id_map is not None:
            id_map[node_id] = item
        result.append({
            "id": node_id,
            "title": item.title,
            "page": _outline_item_page(doc, item),
            "top": _outline_item_top(doc, item),
            "children": _walk_outline(doc, item.children, counter, id_map),
        })
    return result


def _get_outline_tree(doc):
    """The current outline as a JSON-able tree, for embedding in a command's
    response the same way _rebuild_registry()'s tag tree is - a no-op
    open_outline() session (nothing is mutated) so this is safe to call
    read-only from anywhere."""
    with doc["pdf"].open_outline() as outline:
        return _walk_outline(doc, outline.root, [0])


def _locate_outline_item(outline, bookmark_id):
    """(containing_list, item) for `bookmark_id` within `outline.root`'s
    tree - `containing_list` is whichever Python list (the root list, or
    some ancestor's .children) directly holds it, for a caller that wants to
    remove/replace it there. None if not found. Must be called against an
    `outline` whose .root hasn't been saved/reloaded since the id was handed
    out - see _walk_outline()."""
    counter = [0]

    def walk(items):
        for item in items:
            counter[0] += 1
            node_id = f"b{counter[0]}"
            if node_id == bookmark_id:
                return items, item
            found = walk(item.children)
            if found is not None:
                return found
        return None

    return walk(outline.root)


def rename_bookmark(doc_id, bookmark_id, title):
    doc = documents[doc_id]
    outline = doc["pdf"].open_outline()
    located = _locate_outline_item(outline, bookmark_id)
    if located is None:
        raise ValueError(f"Unknown bookmark id: {bookmark_id}")
    _, item = located

    _push_undo_snapshot(doc)
    with outline:
        item.title = title

    return {"outline": _get_outline_tree(doc), **_undo_state(doc)}


def delete_bookmark(doc_id, bookmark_id):
    doc = documents[doc_id]
    outline = doc["pdf"].open_outline()
    located = _locate_outline_item(outline, bookmark_id)
    if located is None:
        raise ValueError(f"Unknown bookmark id: {bookmark_id}")
    containing_list, item = located

    _push_undo_snapshot(doc)
    with outline:
        containing_list.remove(item)

    return {"outline": _get_outline_tree(doc), **_undo_state(doc)}


def generate_bookmarks(doc_id, headings):
    """Replaces the whole outline with a fresh one built from `headings` -
    an ordered (document-order) list of {title, level (1-6), page
    (0-based), top} dicts that the renderer collects from the tag tree's
    H1-H6 nodes (see collectHeadingsForBookmarks() in renderer.js): each
    heading's title comes from pdf.js's content extraction over there,
    which this Python side has no equivalent of (recovering text from a
    content stream by marked-content id isn't something pikepdf does), and
    `top` is the heading's own vertical position on the page (also computed
    over there, from the same text-run geometry pdf.js already resolved for
    tag highlighting) so the bookmark scrolls straight to the heading rather
    than just the top of its page. Nesting follows heading level via a
    stack: a heading becomes a child of the nearest preceding heading with a
    strictly lower level, or a top-level item if none - the standard way to
    rebuild a tree from a flat leveled list. An empty `headings` list just
    clears the outline. Backs the Bookmarks panel's Generate button."""
    doc = documents[doc_id]

    root = []
    stack = []  # [(level, that_heading's_children_list)], innermost open ancestor last
    for h in headings:
        level = h.get("level")
        page = h.get("page")
        if not isinstance(level, int) or not isinstance(page, int):
            continue
        title = (h.get("title") or "").strip() or "Untitled"
        top = h.get("top")
        if isinstance(top, (int, float)):
            item = pikepdf.OutlineItem(title, page, page_location="FitH", top=top)
        else:
            item = pikepdf.OutlineItem(title, page)

        while stack and stack[-1][0] >= level:
            stack.pop()
        (stack[-1][1] if stack else root).append(item)
        stack.append((level, item.children))

    _push_undo_snapshot(doc)
    with doc["pdf"].open_outline() as outline:
        outline.root = root

    return {"outline": _get_outline_tree(doc), **_undo_state(doc)}


def _is_container(doc, node_id):
    """True if `node_id` can validly be a reorder drop target - the struct
    root, or a struct element. Content leaves (bare MCID, /MCR, /OBJR) have
    no /K of their own and can't accept children."""
    return node_id == "root" or doc["node_kind"].get(node_id) == "element"


# --- command handlers --------------------------------------------------

def open_document(path):
    # Save (as opposed to Save As) can write back over this same path, so
    # pikepdf needs to be told up front that overwriting the input is okay.
    pdf = pikepdf.open(path, allow_overwriting_input=True)
    doc_id = str(uuid.uuid4())
    documents[doc_id] = {
        "pdf": pdf, "elements": {}, "parent_map": {}, "node_pages": {},
        "node_kind": {}, "counter": 0,
        "page_index_by_objgen": {page.objgen: i for i, page in enumerate(pdf.pages)},
        "undo_stack": [], "redo_stack": [],
    }
    doc = documents[doc_id]
    outline_tree = _get_outline_tree(doc)
    doc_info = _get_doc_info(doc)

    if "/StructTreeRoot" not in pdf.Root:
        return {
            "docId": doc_id, "hasStructTree": False, "tree": None,
            "outline": outline_tree, "docInfo": doc_info, **_undo_state(doc),
        }

    tree = _rebuild_registry(doc_id)
    return {
        "docId": doc_id, "hasStructTree": True, "tree": tree,
        "outline": outline_tree, "docInfo": doc_info, **_undo_state(doc),
    }


def update_node(doc_id, node_id, changes):
    doc = documents[doc_id]
    if node_id not in doc["elements"]:
        raise ValueError(f"Unknown node id: {node_id}")
    if node_id == "root":
        raise ValueError("The document root has no editable attributes")
    if doc["node_kind"].get(node_id) != "element":
        raise ValueError("Content leaves have no editable attributes")

    _push_undo_snapshot(doc)
    elem = doc["elements"][node_id]

    if changes.get("role"):
        role = changes["role"]
        role = role if role.startswith("/") else "/" + role
        elem["/S"] = pikepdf.Name(role)

    if "alt" in changes:
        _set_or_clear_string(elem, "/Alt", changes["alt"])
    if "actualText" in changes:
        _set_or_clear_string(elem, "/ActualText", changes["actualText"])
    if "lang" in changes:
        _set_or_clear_string(elem, "/Lang", changes["lang"])
    _apply_table_attr_changes(doc, elem, changes)

    return {"tree": _rebuild_registry(doc_id), **_undo_state(doc)}


def update_nodes(doc_id, node_ids, changes):
    """Bulk variant of update_node - applies the same `changes` to every
    listed node as one undo step (used by the tag tree's multi-select Role
    edit: change one field for every selected tag in a single action rather
    than one undo entry per tag)."""
    doc = documents[doc_id]
    targets = []
    for node_id in node_ids:
        if node_id == "root":
            raise ValueError("The document root has no editable attributes")
        if node_id not in doc["elements"]:
            raise ValueError(f"Unknown node id: {node_id}")
        if doc["node_kind"].get(node_id) != "element":
            raise ValueError("Content leaves have no editable attributes")
        targets.append(doc["elements"][node_id])
    if not targets:
        raise ValueError("No nodes to update")

    _push_undo_snapshot(doc)
    for elem in targets:
        if changes.get("role"):
            role = changes["role"]
            role = role if role.startswith("/") else "/" + role
            elem["/S"] = pikepdf.Name(role)

        if "alt" in changes:
            _set_or_clear_string(elem, "/Alt", changes["alt"])
        if "actualText" in changes:
            _set_or_clear_string(elem, "/ActualText", changes["actualText"])
        if "lang" in changes:
            _set_or_clear_string(elem, "/Lang", changes["lang"])
        _apply_table_attr_changes(doc, elem, changes)

    return {"tree": _rebuild_registry(doc_id), **_undo_state(doc)}


def shift_heading_levels(doc_id, node_ids, direction):
    """Bulk heading-level step for the tag tree's Headings-filter multi-select:
    each listed node's H-level moves by `direction` (+1/-1), clamped to
    H1-H6, computed independently per node (so an H1 and H3 selected
    together become H2 and H4). Non-heading nodes are left untouched. All
    changes land as a single undo step."""
    doc = documents[doc_id]
    targets = []
    for node_id in node_ids:
        if node_id == "root":
            raise ValueError("The document root has no editable attributes")
        if node_id not in doc["elements"]:
            raise ValueError(f"Unknown node id: {node_id}")
        if doc["node_kind"].get(node_id) != "element":
            raise ValueError("Content leaves have no editable attributes")
        targets.append(doc["elements"][node_id])
    if not targets:
        raise ValueError("No nodes to update")

    _push_undo_snapshot(doc)
    for elem in targets:
        role = str(elem["/S"]).lstrip("/") if "/S" in elem else ""
        match = re.match(r"^H([1-6])$", role)
        if not match:
            continue
        level = int(match.group(1))
        new_level = level + direction
        if 1 <= new_level <= 6:
            elem["/S"] = pikepdf.Name(f"/H{new_level}")

    return {"tree": _rebuild_registry(doc_id), **_undo_state(doc)}


def reorder_node(doc_id, node_id, new_parent_id, new_index):
    doc = documents[doc_id]
    if node_id == "root":
        raise ValueError("Cannot move the document root")
    if node_id not in doc["elements"]:
        raise ValueError(f"Unknown node id: {node_id}")
    if new_parent_id not in doc["elements"]:
        raise ValueError(f"Unknown target parent id: {new_parent_id}")
    if not _is_container(doc, new_parent_id):
        raise ValueError("Cannot move a tag into a content leaf")

    if new_parent_id == node_id:
        raise ValueError("A node cannot become its own parent")

    # Refuse a move that would create a cycle (dropping a node onto one of
    # its own descendants). Walk up from the proposed new parent; if we hit
    # node_id before running out of ancestors, it's a descendant.
    walker = new_parent_id
    while walker is not None:
        if walker == node_id:
            raise ValueError("Cannot move a node into its own descendant")
        walker = doc["parent_map"].get(walker)

    current_parent_id = doc["parent_map"].get(node_id)
    if current_parent_id is None:
        raise ValueError(f"Node {node_id} has no tracked parent - cannot move it")

    # A bare MCID leaf has no /Pg of its own - it takes whatever page its
    # containing struct element resolves to (see the module docstring), so
    # reparenting it under an element on a different page would silently
    # mislabel which page's content it points at.
    if doc["node_kind"].get(node_id) == "content-int" and doc["node_pages"].get(new_parent_id) != doc["node_pages"].get(node_id):
        raise ValueError("Can't move marked content to a tag on a different page")

    _push_undo_snapshot(doc)
    node_obj = doc["elements"][node_id]
    old_parent_obj = doc["elements"][current_parent_id]
    new_parent_obj = doc["elements"][new_parent_id]

    _remove_kid(old_parent_obj, node_obj)
    _insert_kid(new_parent_obj, node_obj, new_index)
    if isinstance(node_obj, pikepdf.Dictionary):
        node_obj["/P"] = new_parent_obj

    return {"tree": _rebuild_registry(doc_id), **_undo_state(doc)}


def reorder_many(doc_id, node_ids, new_parent_id, new_index):
    """Block variant of reorder_node - moves several nodes to consecutive
    slots starting at new_index, in the order given (the renderer sends
    them in current document order), as one undo step. Used by the tag
    tree's multi-select drag-and-drop and Ctrl+Up/Down block move."""
    doc = documents[doc_id]
    if not node_ids:
        raise ValueError("No nodes to move")
    if new_parent_id not in doc["elements"]:
        raise ValueError(f"Unknown target parent id: {new_parent_id}")
    if not _is_container(doc, new_parent_id):
        raise ValueError("Cannot move a tag into a content leaf")

    seen = set()
    unique_ids = []
    for node_id in node_ids:
        if node_id == "root":
            raise ValueError("Cannot move the document root")
        if node_id not in doc["elements"]:
            raise ValueError(f"Unknown node id: {node_id}")
        if node_id == new_parent_id:
            raise ValueError("A node cannot become its own parent")
        # See reorder_node: a bare MCID leaf's page is inherited from its
        # containing element, so it can't be reparented across pages.
        if doc["node_kind"].get(node_id) == "content-int" and doc["node_pages"].get(new_parent_id) != doc["node_pages"].get(node_id):
            raise ValueError("Can't move marked content to a tag on a different page")
        if node_id not in seen:
            seen.add(node_id)
            unique_ids.append(node_id)

    # Refuse a move that would create a cycle (the new parent is one of the
    # moved nodes' own descendants) - same walk-up check as reorder_node,
    # just repeated per moved node.
    for node_id in unique_ids:
        walker = new_parent_id
        while walker is not None:
            if walker == node_id:
                raise ValueError("Cannot move a node into its own descendant")
            walker = doc["parent_map"].get(walker)

    _push_undo_snapshot(doc)
    new_parent_obj = doc["elements"][new_parent_id]

    # Remove every moved node from its current parent *before* inserting
    # any of them. Interleaving remove+insert per node (the naive approach)
    # breaks for a block moving down within the same parent: each earlier
    # sibling's removal shifts everything after it left, so new_index -
    # taken at face value for later nodes in the block - no longer points
    # where it did when only the first node had been removed. Doing every
    # removal up front means new_index only ever has to be interpreted
    # once, against the parent's final (fully-reduced) children list.
    for node_id in unique_ids:
        node_obj = doc["elements"][node_id]
        current_parent_id = doc["parent_map"].get(node_id)
        old_parent_obj = doc["elements"].get(current_parent_id) if current_parent_id else None
        if old_parent_obj is not None:
            _remove_kid(old_parent_obj, node_obj)

    insertion_index = new_index
    for node_id in unique_ids:
        node_obj = doc["elements"][node_id]
        _insert_kid(new_parent_obj, node_obj, insertion_index)
        if isinstance(node_obj, pikepdf.Dictionary):
            node_obj["/P"] = new_parent_obj
        insertion_index += 1

    return {"tree": _rebuild_registry(doc_id), **_undo_state(doc)}


def _count_divs(struct_obj):
    count = 0
    for kid in _iter_kids(struct_obj):
        if isinstance(kid, pikepdf.Dictionary) and "/S" in kid:
            if str(kid["/S"]).lstrip("/") == "Div":
                count += 1
            count += _count_divs(kid)
    return count


def _flatten_divs(struct_obj):
    """Recursively removes /Div struct elements from struct_obj's subtree,
    splicing each one's own kids into its parent's /K in its place (so the
    Div's contents are kept, just un-nested by one level). Mutates /K on
    every ancestor whose kids changed, and reparents (/P) any surviving
    struct-element grandkids to their new direct parent."""
    changed = False
    new_kids = []
    for kid in _iter_kids(struct_obj):
        if isinstance(kid, pikepdf.Dictionary) and "/S" in kid:
            _flatten_divs(kid)  # post-order: flatten nested Divs first
            if str(kid["/S"]).lstrip("/") == "Div":
                changed = True
                for grandkid in _iter_kids(kid):
                    if isinstance(grandkid, pikepdf.Dictionary) and "/S" in grandkid:
                        grandkid["/P"] = struct_obj
                    new_kids.append(grandkid)
                continue
        new_kids.append(kid)
    if changed:
        if new_kids:
            struct_obj["/K"] = pikepdf.Array(new_kids)
        elif "/K" in struct_obj:
            del struct_obj["/K"]


def kill_divs(doc_id):
    doc = documents[doc_id]
    struct_root = doc["elements"]["root"]
    removed = _count_divs(struct_root)
    if removed == 0:
        return {"tree": _rebuild_registry(doc_id), "removed": 0, **_undo_state(doc)}

    _push_undo_snapshot(doc)
    _flatten_divs(struct_root)
    return {"tree": _rebuild_registry(doc_id), "removed": removed, **_undo_state(doc)}


def _role_of(struct_obj):
    return str(struct_obj["/S"]).lstrip("/") if "/S" in struct_obj else None


def _collect_tables(struct_obj, out):
    """Depth-first collection of every Table struct element anywhere in
    struct_obj's subtree, including tables nested inside another table's
    cells - each one is scoped independently."""
    for kid in _iter_kids(struct_obj):
        if isinstance(kid, pikepdf.Dictionary) and "/S" in kid:
            if _role_of(kid) == "Table":
                out.append(kid)
            _collect_tables(kid, out)


def _collect_rows(table_obj):
    """Ordered list of a Table's TR struct elements, flattening through any
    THead/TBody/TFoot wrappers. Stops at a nested Table (its rows belong to
    that inner table, not this one)."""
    rows = []

    def walk(struct_obj):
        for kid in _iter_kids(struct_obj):
            if not (isinstance(kid, pikepdf.Dictionary) and "/S" in kid):
                continue
            role = _role_of(kid)
            if role == "TR":
                rows.append(kid)
            elif role in ("THead", "TBody", "TFoot"):
                walk(kid)

    walk(table_obj)
    return rows


def _collect_cells(row_obj):
    """Ordered list of a TR's TH/TD struct-element kids."""
    return [
        kid for kid in _iter_kids(row_obj)
        if isinstance(kid, pikepdf.Dictionary) and "/S" in kid and _role_of(kid) in ("TH", "TD")
    ]


def _set_cell_scope(doc, cell_obj, scope_value):
    _ensure_table_attr_obj(doc, cell_obj)["/Scope"] = pikepdf.Name("/" + scope_value)


def scope_tables(doc_id):
    """Walks every Table tag in the document and sets its TH cells' Scope
    attribute from the shape of its header cells, backing the toolbar's
    'Scope Tables' button:
      - a header row (first row all TH) with no TH cells anywhere else ->
        those header-row TH cells get Column scope.
      - every row's first cell is TH (row headers, no distinct header row) ->
        those first-cell TH cells get Row scope.
      - both at once (header row all TH, and every other row also leads with
        a TH) -> the header row's first TH is Both, the rest of the header
        row is Column, and the leading TH of every other row is Row.
    Tables that match none of these shapes (e.g. TH cells scattered
    elsewhere) are left untouched. Leaves the document unchanged (no undo
    snapshot) if there was nothing to scope."""
    doc = documents[doc_id]
    struct_root = doc["elements"]["root"]
    tables = []
    _collect_tables(struct_root, tables)

    scoped = 0
    pending = []  # [(cell_obj, scope_value), ...] - collected before mutating anything
    for table in tables:
        rows = _collect_rows(table)
        if not rows:
            continue
        row_cells = [_collect_cells(row) for row in rows]
        first_row_cells = row_cells[0]
        other_rows_cells = row_cells[1:]
        if not first_row_cells:
            continue

        first_row_all_th = all(_role_of(c) == "TH" for c in first_row_cells)
        other_rows_begin_with_th = bool(other_rows_cells) and all(
            cells and _role_of(cells[0]) == "TH" for cells in other_rows_cells
        )
        other_rows_have_no_th = all(
            all(_role_of(c) != "TH" for c in cells) for cells in other_rows_cells
        )
        all_rows_begin_with_th = all(
            cells and _role_of(cells[0]) == "TH" for cells in row_cells
        )

        table_changes = []
        if first_row_all_th and other_rows_begin_with_th:
            table_changes.append((first_row_cells[0], "Both"))
            table_changes.extend((c, "Column") for c in first_row_cells[1:])
            table_changes.extend((cells[0], "Row") for cells in other_rows_cells)
        elif first_row_all_th and other_rows_have_no_th:
            table_changes.extend((c, "Column") for c in first_row_cells)
        elif all_rows_begin_with_th:
            table_changes.extend((cells[0], "Row") for cells in row_cells)

        if table_changes:
            pending.extend(table_changes)
            scoped += 1

    if not pending:
        return {"tree": _rebuild_registry(doc_id), "tablesScoped": 0, **_undo_state(doc)}

    _push_undo_snapshot(doc)
    for cell_obj, scope_value in pending:
        _set_cell_scope(doc, cell_obj, scope_value)

    return {"tree": _rebuild_registry(doc_id), "tablesScoped": scoped, **_undo_state(doc)}


def delete_nodes(doc_id, node_ids):
    """Removes each of `node_ids` from its parent's /K, taking its entire
    subtree with it. Backs the tag tree's Delete key for both cases it
    handles: a struct element ("tag") is fully removed along with its
    descendants, and a content/object-ref leaf is unlinked from the struct
    tree the same way - since this editor never touches content-stream
    marked-content operators (see the module docstring), removing
    structure's only reference to a piece of content is what "artifact" it
    means here: assistive tech skips unreferenced content exactly as it
    would a real /Artifact tag."""
    doc = documents[doc_id]
    if not node_ids:
        raise ValueError("No nodes to delete")

    for node_id in node_ids:
        if node_id == "root":
            raise ValueError("Cannot delete the document root")
        if node_id not in doc["elements"]:
            raise ValueError(f"Unknown node id: {node_id}")

    # Removing an ancestor already takes any selected descendant with it -
    # see _top_level_selection.
    top_level = _top_level_selection(doc, node_ids)

    _push_undo_snapshot(doc)
    for node_id in top_level:
        node_obj = doc["elements"][node_id]
        parent_id = doc["parent_map"].get(node_id)
        parent_obj = doc["elements"].get(parent_id) if parent_id is not None else None
        if parent_obj is not None:
            _remove_kid(parent_obj, node_obj)

    return {"tree": _rebuild_registry(doc_id), **_undo_state(doc)}


# --- figure-from-rectangle tagging ----------------------------------------
#
# Backs the "Add Figure" draw tool: the renderer lets the user drag a
# rectangle over the PDF preview (in PDF page-space, already converted from
# canvas pixels via pdf.js's viewport.convertToPdfPoint() - see renderer.js),
# and this turns that rectangle into a new /Figure struct element. This is
# the one command in this file that reads a page's content stream - but only
# ever reads it, to recover where each image XObject is actually placed
# (pikepdf/qpdf exposes no ready-made "what's under this rectangle" query).
# It never adds or rewrites marked-content (BDC/EMC) operators.
#
# Two outcomes, chosen automatically per rectangle - the caller doesn't pick:
#   - "object": the rectangle matches a distinct image XObject reasonably
#     tightly. Tag it directly via an /OBJR object reference - no
#     content-stream edit needed at all, since /OBJR exists precisely for
#     referencing an object that was never wrapped in BDC/EMC marked content
#     (the same mechanism annotations use).
#   - "bbox": no distinct image matches closely enough - most commonly
#     because the whole page is one big scanned background image, which a
#     rectangle drawn over any one figure on it will also overlap, just at
#     far lower coverage than a real match (see FULL_PAGE_IMAGE_COVERAGE).
#     The Figure gets a /BBox layout attribute and no /K instead. This is
#     the same fallback Acrobat itself uses when you manually draw a figure
#     region with nothing distinct underneath: the Alt text still reads out
#     in tree order, it's just not tied to any specific marked content.
#
# The new Figure is always attached under the document's /Document element
# (see _document_insertion_parent) rather than root - a bare tag hung
# directly off /StructTreeRoot would sit as a stray sibling of /Document,
# i.e. outside the one element PDF/UA expects to wrap the entire document.
#
# Where it lands among /Document's existing kids is also estimated rather
# than always appended at the end: _estimate_insert_index() ranks the new
# rectangle's (page, y) against every existing kid's own (page, y) - the
# page-space point where that kid's first positioned descendant begins,
# found via a DFS in document order (see _first_positioned_descendant) -
# and slots the new Figure in just before the first kid that would come
# after it in reading order. "Where a tag begins" comes from whichever of
# these its subtree has: an MCID's text anchor (_page_anchor_info tracks
# the text matrix - Tm/Td/TD/T*, no font metrics - well enough to rank
# spans top-to-bottom, not to measure them), a placed image XObject's top
# edge, or - for an already-bbox-tagged Figure - its own /Layout /BBox.
# It's an estimate, not a guarantee: a kid with no positioned descendant
# anywhere in its subtree (an empty container, or one built entirely from
# things this heuristic can't see) is skipped as a candidate boundary, and
# the drag/drop reordering the tag tree already supports is still there for
# whatever the estimate gets wrong.

def _mat_mult(m1, m2):
    """Composes two PDF transformation matrices as `m1` applied first, `m2`
    second - i.e. a point transforms as `point * m1 * m2`. This is the order
    a content stream's `cm` operator combines with the CTM already in
    effect: the new matrix describes the *inner* (most recently established)
    coordinate system."""
    a1, b1, c1, d1, e1, f1 = m1
    a2, b2, c2, d2, e2, f2 = m2
    return (
        a1 * a2 + b1 * c2,
        a1 * b2 + b1 * d2,
        c1 * a2 + d1 * c2,
        c1 * b2 + d1 * d2,
        e1 * a2 + f1 * c2 + e2,
        e1 * b2 + f1 * d2 + f2,
    )


def _mat_apply(point, m):
    x, y = point
    a, b, c, d, e, f = m
    return (a * x + c * y + e, b * x + d * y + f)


def _rect_area(r):
    x0, y0, x1, y1 = r
    return max(0.0, x1 - x0) * max(0.0, y1 - y0)


def _rect_intersection_area(a, b):
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[2], b[2]), min(a[3], b[3])
    return _rect_area((x0, y0, x1, y1))


def _resolve_inherited(page_obj, key, default=None):
    """Walks /Parent (the Pages tree) for a page attribute that's allowed to
    be inherited rather than set directly on the page itself - /Resources
    and /MediaBox both are, and a scanned document built from one shared
    template per section often relies on that instead of repeating them on
    every page."""
    node = page_obj
    seen = set()
    while node is not None:
        if key in node:
            return node[key]
        parent = node.get("/Parent")
        if not isinstance(parent, pikepdf.Dictionary):
            return default
        if getattr(parent, "is_indirect", False):
            if parent.objgen in seen:
                return default
            seen.add(parent.objgen)
        node = parent
    return default


def _page_image_placements(page):
    """Every top-level (not inside a nested Form XObject) `Do` call onto an
    Image XObject on `page`, as {"xobject": <the resolved image stream>,
    "bbox": (x0, y0, x1, y1)} in the page's default user space. Computed by
    replaying just enough of the content stream to track the CTM (q/Q/cm) -
    Form XObjects are out of scope (their own nested coordinate system would
    need this same treatment recursively, and scanned pages/pasted photos
    are essentially always plain Image XObjects, not Forms)."""
    resources = _resolve_inherited(page.obj, "/Resources")
    xobjects = resources.get("/XObject") if isinstance(resources, pikepdf.Dictionary) else None
    if not xobjects:
        return []

    placements = []
    ctm = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    stack = []
    try:
        instructions = pikepdf.parse_content_stream(page, "q Q cm Do")
    except Exception:
        return []

    for instr in instructions:
        op = str(instr.operator)
        if op == "q":
            stack.append(ctm)
        elif op == "Q":
            if stack:
                ctm = stack.pop()
        elif op == "cm" and len(instr.operands) == 6:
            try:
                m = tuple(float(v) for v in instr.operands)
            except (TypeError, ValueError):
                continue
            ctm = _mat_mult(m, ctm)
        elif op == "Do" and instr.operands:
            xobj = xobjects.get(str(instr.operands[0]))
            # An Image XObject is a *stream* (pixel data plus a dict of
            # keys), not a plain Dictionary - pikepdf.Stream isn't a
            # subclass of pikepdf.Dictionary, so both need checking here.
            if not isinstance(xobj, (pikepdf.Dictionary, pikepdf.Stream)):
                continue
            if str(xobj.get("/Subtype", "")) != "/Image":
                continue
            corners = [_mat_apply(p, ctm) for p in ((0, 0), (1, 0), (1, 1), (0, 1))]
            xs, ys = [p[0] for p in corners], [p[1] for p in corners]
            placements.append({"xobject": xobj, "bbox": (min(xs), min(ys), max(xs), max(ys))})

    return placements


# A candidate image covering this much of the page's own area is treated as
# the scan background, not a distinct figure - same threshold and rationale
# as FULL_PAGE_LEAF_COVERAGE in renderer.js (that one works from already-
# tagged MCID leaves; this one works from raw content-stream placements, so
# it can't share the constant, but the two should stay in sync).
FULL_PAGE_IMAGE_COVERAGE = 0.9

# How much of the smaller of {drawn rectangle, candidate image} their
# intersection must cover for the candidate to count as "this *is* the
# figure the user meant", rather than just some image the rectangle happens
# to overlap a corner of.
MIN_XOBJECT_OVERLAP = 0.6


def _next_struct_parent_key(struct_root):
    """Allocates a fresh top-level key in /StructTreeRoot's /ParentTree
    number tree, for a struct element reached via /OBJR rather than a bare
    MCID (see _register_struct_parent). Prefers /ParentTreeNextKey (PDF
    32000-1 14.7.4.4 says a writer should trust and advance it); falls back
    to scanning /ParentTree's /Nums for the highest existing key if it's
    absent."""
    next_key = struct_root.get("/ParentTreeNextKey")
    if next_key is not None:
        try:
            return int(next_key)
        except (TypeError, ValueError):
            pass
    parent_tree = struct_root.get("/ParentTree")
    if isinstance(parent_tree, pikepdf.Dictionary) and "/Kids" in parent_tree:
        raise ValueError(
            "This document's structure ParentTree uses /Kids (a multi-level "
            "number tree), which isn't supported yet"
        )
    max_key = -1
    if isinstance(parent_tree, pikepdf.Dictionary) and "/Nums" in parent_tree:
        nums = parent_tree["/Nums"]
        for i in range(0, len(nums) - 1, 2):
            try:
                max_key = max(max_key, int(nums[i]))
            except (TypeError, ValueError):
                continue
    return max_key + 1


def _register_struct_parent(doc, key, struct_elem):
    """Adds `key -> struct_elem` to /StructTreeRoot's /ParentTree and
    advances /ParentTreeNextKey past it - the object-reference counterpart
    of a page's /StructParents array (which does the same for bare-MCID
    content, just nested one level deeper as an array-per-page). Shares
    _next_struct_parent_key's /Kids limitation."""
    struct_root = doc["elements"]["root"]
    parent_tree = struct_root.get("/ParentTree")
    if not isinstance(parent_tree, pikepdf.Dictionary):
        parent_tree = doc["pdf"].make_indirect(pikepdf.Dictionary({"/Nums": pikepdf.Array([])}))
        struct_root["/ParentTree"] = parent_tree
    if "/Nums" not in parent_tree:
        raise ValueError(
            "This document's structure ParentTree uses /Kids (a multi-level "
            "number tree), which isn't supported yet"
        )

    nums = list(parent_tree["/Nums"])
    insert_at = len(nums)
    for i in range(0, len(nums) - 1, 2):
        if int(nums[i]) > key:
            insert_at = i
            break
    nums[insert_at:insert_at] = [key, struct_elem]
    parent_tree["/Nums"] = pikepdf.Array(nums)

    prior_next = struct_root.get("/ParentTreeNextKey")
    prior_next = int(prior_next) if prior_next is not None else 0
    struct_root["/ParentTreeNextKey"] = max(prior_next, key + 1)


def _page_anchor_info(page):
    """One combined content-stream pass producing everything
    _estimate_insert_index() needs to rank existing content top-to-bottom:
      - "mcid": {mcid: y} - the page-space y where each MCID's marked
        content begins. Tracks the text matrix (BT/ET, Tm, Td/TD, T*) the
        same way _page_image_placements tracks the CTM, but carries no font
        metrics at all - Tj/TJ never move the tracked position - so this is
        only good for ranking spans top-to-bottom, not for measuring them.
        The position is taken at the *first text-showing operator* (Tj/TJ/
        '/") after the MCID's BDC, not at the BDC itself: real generators
        commonly emit `BDC` right after `BT`, before the `Tm`/`Td` that
        actually places the text (this file's own test-complex.pdf fixture
        does exactly that), so anchoring at BDC-open would read every such
        span's position as wherever the text matrix happened to be left by
        whatever came before - typically the BT-reset identity matrix, i.e.
        the page origin, wrongly ranking it first every time. BDC-open is
        still recorded as a fallback baseline, for a marked span that's
        graphical rather than textual (no Tj ever fires inside it) - a
        stroked/filled vector figure, most notably.
      - "xobject": {objgen: y} - the top edge of each image XObject's placed
        bbox, keyed by the object's own identity so a leaf referencing it
        via /OBJR (see figure_from_rect's "object" strategy) can look
        itself up directly rather than needing its own placement pass.
    """
    result = {"mcid": {}, "xobject": {}}
    resources = _resolve_inherited(page.obj, "/Resources")
    xobjects = resources.get("/XObject") if isinstance(resources, pikepdf.Dictionary) else None

    ctm = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    stack = []
    tm = tlm = None  # text matrix / text line matrix - only meaningful inside BT/ET
    leading = 0.0
    mcid_stack = []
    finalized = set()  # mcids whose anchor came from a real Tj/TJ/'/", not just BDC-open

    try:
        instructions = pikepdf.parse_content_stream(
            page, "q Q cm BT ET Tm Td TD T* TL Do BDC BMC EMC Tj TJ ' \""
        )
    except Exception:
        return result

    for instr in instructions:
        op = str(instr.operator)
        ops = instr.operands
        if op == "q":
            stack.append(ctm)
        elif op == "Q":
            if stack:
                ctm = stack.pop()
        elif op == "cm" and len(ops) == 6:
            try:
                m = tuple(float(v) for v in ops)
            except (TypeError, ValueError):
                continue
            ctm = _mat_mult(m, ctm)
        elif op == "BT":
            tm = tlm = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
            leading = 0.0
        elif op == "ET":
            tm = tlm = None
        elif op == "Tm" and len(ops) == 6:
            try:
                tm = tlm = tuple(float(v) for v in ops)
            except (TypeError, ValueError):
                continue
        elif op == "TL" and len(ops) == 1:
            try:
                leading = float(ops[0])
            except (TypeError, ValueError):
                pass
        elif op in ("Td", "TD") and len(ops) == 2 and tlm is not None:
            try:
                tx, ty = float(ops[0]), float(ops[1])
            except (TypeError, ValueError):
                continue
            if op == "TD":
                leading = -ty
            tlm = _mat_mult((1.0, 0.0, 0.0, 1.0, tx, ty), tlm)
            tm = tlm
        elif op == "T*" and tlm is not None:
            tlm = _mat_mult((1.0, 0.0, 0.0, 1.0, 0.0, -leading), tlm)
            tm = tlm
        elif op == "Do" and ops and xobjects is not None:
            xobj = xobjects.get(str(ops[0]))
            if (isinstance(xobj, (pikepdf.Dictionary, pikepdf.Stream))
                    and str(xobj.get("/Subtype", "")) == "/Image"
                    and getattr(xobj, "is_indirect", False)):
                corners = [_mat_apply(p, ctm) for p in ((0, 0), (1, 0), (1, 1), (0, 1))]
                result["xobject"].setdefault(xobj.objgen, max(p[1] for p in corners))
        elif op == "BDC" and len(ops) == 2:
            mcid = None
            props = ops[1]
            if isinstance(props, pikepdf.Dictionary) and "/MCID" in props:
                try:
                    mcid = int(props["/MCID"])
                except (TypeError, ValueError):
                    mcid = None
            mcid_stack.append(mcid)
            if mcid is not None and mcid not in result["mcid"]:
                pen = _mat_mult(tm, ctm) if tm is not None else ctm
                result["mcid"][mcid] = _mat_apply((0, 0), pen)[1]
        elif op == "BMC":
            mcid_stack.append(None)
        elif op == "EMC":
            if mcid_stack:
                mcid_stack.pop()
        elif op in ("Tj", "TJ", "'", '"') and mcid_stack and mcid_stack[-1] is not None:
            mcid = mcid_stack[-1]
            if mcid not in finalized:
                pen = _mat_mult(tm, ctm) if tm is not None else ctm
                result["mcid"][mcid] = _mat_apply((0, 0), pen)[1]
                finalized.add(mcid)

    return result


def _first_positioned_descendant(doc, node_id, get_page_anchors):
    """DFS over `node_id`'s subtree in document order (the same order
    `_direct_child_ids` walks), returning the first (page, y) position found
    - from a bare MCID's text/image anchor (see _page_anchor_info), an
    /OBJR's target image, or - checked last, so real content always wins -
    the element's own /Layout /BBox. None if nothing in the subtree (or the
    element itself) is positioned. `get_page_anchors(page_index)` is a
    memoizing accessor over _page_anchor_info, shared across a whole
    _estimate_insert_index() call so each page is only parsed once."""
    kind = doc["node_kind"].get(node_id)
    obj = doc["elements"].get(node_id)
    page = doc["node_pages"].get(node_id)

    if kind == "content-int":  # bare MCID
        if page is not None and isinstance(obj, int):
            y = get_page_anchors(page)["mcid"].get(obj)
            if y is not None:
                return (page, y)
        return None

    if kind == "content-dict":  # /MCR or /OBJR
        if page is not None and isinstance(obj, pikepdf.Dictionary):
            mcid_val = None
            if "/MCID" in obj:
                try:
                    mcid_val = int(obj["/MCID"])
                except (TypeError, ValueError):
                    mcid_val = None
            if mcid_val is not None:
                y = get_page_anchors(page)["mcid"].get(mcid_val)
                if y is not None:
                    return (page, y)
            target = obj.get("/Obj")
            if isinstance(target, (pikepdf.Dictionary, pikepdf.Stream)) and getattr(target, "is_indirect", False):
                y = get_page_anchors(page)["xobject"].get(target.objgen)
                if y is not None:
                    return (page, y)
        return None

    if kind == "element":
        for child_id in _direct_child_ids(doc, node_id):
            found = _first_positioned_descendant(doc, child_id, get_page_anchors)
            if found is not None:
                return found
        if isinstance(obj, pikepdf.Dictionary):
            bbox = _find_layout_bbox(obj)
            if bbox is not None and page is not None:
                return (page, max(bbox[1], bbox[3]))

    return None


def _position_before(a, b):
    """True if page-space position `a` (page, y) sorts strictly before `b`
    in reading order: an earlier page, or the same page and higher up (PDF's
    y-axis grows upward, so "higher up" is a larger y)."""
    if a[0] != b[0]:
        return a[0] < b[0]
    return a[1] > b[1]


def _estimate_insert_index(doc, parent_node_id, target_page, target_top_y):
    """Where a new Figure at (target_page, target_top_y) belongs among
    `parent_node_id`'s existing kids, in document order - the index of the
    first kid whose own position (see _first_positioned_descendant) comes
    after it, or the end if every positioned kid comes before it (or none
    are positioned at all, the same "append at the end" this replaces)."""
    sibling_ids = _direct_child_ids(doc, parent_node_id)
    anchor_cache = {}

    def get_page_anchors(page_index):
        if page_index not in anchor_cache:
            anchor_cache[page_index] = _page_anchor_info(doc["pdf"].pages[page_index])
        return anchor_cache[page_index]

    target = (target_page, target_top_y)
    for index, child_id in enumerate(sibling_ids):
        sibling_pos = _first_positioned_descendant(doc, child_id, get_page_anchors)
        if sibling_pos is not None and _position_before(target, sibling_pos):
            return index
    return len(sibling_ids)


def _node_id_for_object(doc, obj):
    """The app's synthetic node id currently pointing at the same underlying
    pikepdf object as `obj` (identity, not equality - see _same_object), or
    None if it isn't (or is no longer) registered. `doc["elements"]` is only
    as fresh as the last mutation/_rebuild_registry() call, so this is only
    meaningful for an object that was already part of the tree before the
    current command started mutating it."""
    return next((nid for nid, o in doc["elements"].items() if _same_object(o, obj)), None)


def _document_insertion_parent(doc):
    """Where a newly created top-level tag (currently just figure_from_rect)
    should actually attach: the /Document struct element immediately under
    /StructTreeRoot, if there is one - never the root itself, and never as a
    sibling of /Document at the root level, both of which would leave the
    new tag outside the one element PDF/UA expects to wrap the entire
    document. Falls back to root only for the (non-conforming) case where
    root has no /Document child to begin with, since there's nowhere more
    correct to put it. Returns (parent_obj, parent_node_id)."""
    struct_root = doc["elements"]["root"]
    for kid in _iter_kids(struct_root):
        if isinstance(kid, pikepdf.Dictionary) and str(kid.get("/S", "")).lstrip("/") == "Document":
            node_id = _node_id_for_object(doc, kid)
            if node_id is not None:
                return kid, node_id
    return struct_root, "root"


def _new_figure_shell(doc, page, parent_obj):
    return doc["pdf"].make_indirect(pikepdf.Dictionary({
        "/Type": pikepdf.Name("/StructElem"),
        "/S": pikepdf.Name("/Figure"),
        "/P": parent_obj,
        "/Pg": page.obj,
    }))


def figure_from_rect(doc_id, page_index, rect):
    """Tags a user-drawn rectangle (page-space [x0, y0, x1, y1], PDF default
    user space) as a new /Figure, picking between the "object" and "bbox"
    strategies described in this section's comment automatically - the
    caller doesn't need to know which one ran, though `method` is returned
    in case the UI wants to say. It's attached under the document's
    /Document element (see _document_insertion_parent), not root - a new
    top-level tag directly under /StructTreeRoot would sit outside the one
    element PDF/UA expects to wrap the whole document. Alt text isn't set
    here: like every other freshly created tag in this file (make_list/
    make_table's items, set_role_or_wrap's wrapped leaves), it starts empty
    and is filled in afterward through the normal update_node path."""
    doc = documents[doc_id]
    if "/StructTreeRoot" not in doc["pdf"].Root:
        raise ValueError("This document has no structure tree yet")

    pdf = doc["pdf"]
    if not (0 <= page_index < len(pdf.pages)):
        raise ValueError(f"Invalid page index: {page_index}")
    page = pdf.pages[page_index]

    x0, y0, x1, y1 = rect
    norm_rect = (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))
    rect_area = _rect_area(norm_rect)
    if rect_area <= 0:
        raise ValueError("Figure rectangle has zero area")

    mediabox = _resolve_inherited(page.obj, "/MediaBox")
    page_area = _rect_area(tuple(float(v) for v in mediabox)) if mediabox is not None else 0.0

    best, best_overlap = None, 0.0
    for cand in _page_image_placements(page):
        cand_area = _rect_area(cand["bbox"])
        if cand_area <= 0:
            continue
        if page_area > 0 and cand_area / page_area >= FULL_PAGE_IMAGE_COVERAGE:
            continue  # the scan background, not a distinct figure
        inter = _rect_intersection_area(norm_rect, cand["bbox"])
        if inter <= 0:
            continue
        overlap = inter / min(rect_area, cand_area)
        if overlap > best_overlap:
            best, best_overlap = cand, overlap

    parent_obj, parent_node_id = _document_insertion_parent(doc)

    _push_undo_snapshot(doc)

    if best is not None and best_overlap >= MIN_XOBJECT_OVERLAP:
        figure = _new_figure_shell(doc, page, parent_obj)
        key = _next_struct_parent_key(doc["elements"]["root"])
        best["xobject"]["/StructParent"] = key
        figure["/K"] = pikepdf.Dictionary({
            "/Type": pikepdf.Name("/OBJR"),
            "/Pg": page.obj,
            "/Obj": best["xobject"],
        })
        _register_struct_parent(doc, key, figure)
        method = "object"
    else:
        figure = _new_figure_shell(doc, page, parent_obj)
        figure["/A"] = pikepdf.Dictionary({
            "/O": pikepdf.Name("/Layout"),
            "/BBox": pikepdf.Array([float(v) for v in norm_rect]),
        })
        method = "bbox"

    insert_index = _estimate_insert_index(doc, parent_node_id, page_index, norm_rect[3])
    _insert_kid(parent_obj, figure, insert_index)

    tree = _rebuild_registry(doc_id)
    new_node_id = next((nid for nid, obj in doc["elements"].items() if _same_object(obj, figure)), None)

    return {"tree": tree, "newNodeId": new_node_id, "method": method, **_undo_state(doc)}


def _reindex_pages(doc):
    """Rebuilds page_index_by_objgen against doc["pdf"]'s current page
    objects - qpdf renumbers objects on save/reload, so the mapping built at
    open_document() time silently points at the wrong pages (or nothing)
    once doc["pdf"] has been swapped for a reloaded snapshot, corrupting
    every /Pg- and outline-destination-resolved page number. Call after any
    doc["pdf"] = pikepdf.open(...) reassignment - currently undo_edit() and
    redo_edit()."""
    doc["page_index_by_objgen"] = {page.objgen: i for i, page in enumerate(doc["pdf"].pages)}


def undo_edit(doc_id):
    doc = documents[doc_id]
    if not doc["undo_stack"]:
        raise ValueError("Nothing to undo")
    doc["redo_stack"].append(_snapshot_bytes(doc["pdf"]))
    doc["pdf"].close()
    doc["pdf"] = pikepdf.open(io.BytesIO(doc["undo_stack"].pop()))
    _reindex_pages(doc)
    return {
        "tree": _rebuild_registry(doc_id), "outline": _get_outline_tree(doc),
        "docInfo": _get_doc_info(doc), **_undo_state(doc),
    }


def redo_edit(doc_id):
    doc = documents[doc_id]
    if not doc["redo_stack"]:
        raise ValueError("Nothing to redo")
    doc["undo_stack"].append(_snapshot_bytes(doc["pdf"]))
    doc["pdf"].close()
    doc["pdf"] = pikepdf.open(io.BytesIO(doc["redo_stack"].pop()))
    _reindex_pages(doc)
    return {
        "tree": _rebuild_registry(doc_id), "outline": _get_outline_tree(doc),
        "docInfo": _get_doc_info(doc), **_undo_state(doc),
    }


def save_document(doc_id, path):
    doc = documents[doc_id]
    doc["pdf"].save(path)
    return {"savedPath": path}


# --- main loop -----------------------------------------------------------

def _send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def main():
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            _send({"id": None, "error": f"Invalid JSON from host: {exc}"})
            continue

        req_id = request.get("id")
        cmd = request.get("cmd")
        try:
            if cmd == "open":
                result = open_document(request["path"])
            elif cmd == "update_node":
                result = update_node(request["docId"], request["nodeId"], request.get("changes", {}))
            elif cmd == "update_nodes":
                result = update_nodes(request["docId"], request["nodeIds"], request.get("changes", {}))
            elif cmd == "shift_heading_levels":
                result = shift_heading_levels(request["docId"], request["nodeIds"], request["direction"])
            elif cmd == "reorder":
                result = reorder_node(
                    request["docId"], request["nodeId"],
                    request["newParentId"], request["newIndex"],
                )
            elif cmd == "reorder_many":
                result = reorder_many(
                    request["docId"], request["nodeIds"],
                    request["newParentId"], request["newIndex"],
                )
            elif cmd == "kill_divs":
                result = kill_divs(request["docId"])
            elif cmd == "scope_tables":
                result = scope_tables(request["docId"])
            elif cmd == "delete_nodes":
                result = delete_nodes(request["docId"], request["nodeIds"])
            elif cmd == "figure_from_rect":
                result = figure_from_rect(request["docId"], request["pageIndex"], request["rect"])
            elif cmd == "set_role_or_wrap":
                result = set_role_or_wrap(request["docId"], request["nodeIds"], request["role"])
            elif cmd == "convert_to_paragraph":
                result = convert_to_paragraph(request["docId"], request["nodeIds"])
            elif cmd == "make_list":
                result = make_list(request["docId"], request["nodeIds"])
            elif cmd == "make_table":
                result = make_table(request["docId"], request["nodeIds"])
            elif cmd == "make_tr":
                result = make_tr(request["docId"], request["nodeIds"])
            elif cmd == "undo":
                result = undo_edit(request["docId"])
            elif cmd == "redo":
                result = redo_edit(request["docId"])
            elif cmd == "rename_bookmark":
                result = rename_bookmark(request["docId"], request["bookmarkId"], request["title"])
            elif cmd == "delete_bookmark":
                result = delete_bookmark(request["docId"], request["bookmarkId"])
            elif cmd == "generate_bookmarks":
                result = generate_bookmarks(request["docId"], request.get("headings", []))
            elif cmd == "update_doc_info":
                result = update_doc_info(request["docId"], request.get("changes", {}))
            elif cmd == "save":
                result = save_document(request["docId"], request["path"])
            else:
                raise ValueError(f"Unknown command: {cmd}")
            _send({"id": req_id, "result": result})
        except Exception as exc:  # noqa: BLE001 - report to host, never crash the loop
            _send({"id": req_id, "error": f"{type(exc).__name__}: {exc}"})


if __name__ == "__main__":
    main()
