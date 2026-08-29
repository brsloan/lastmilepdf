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
    not read or written. Custom (non-standard) role names will round-trip
    as opaque strings, but nothing here resolves them against a RoleMap.
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
    if not isinstance(target, pikepdf.Dictionary) or "/Subtype" not in target:
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

    if "/StructTreeRoot" not in pdf.Root:
        return {"docId": doc_id, "hasStructTree": False, "tree": None, **_undo_state(doc)}

    tree = _rebuild_registry(doc_id)
    return {"docId": doc_id, "hasStructTree": True, "tree": tree, **_undo_state(doc)}


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


def undo_edit(doc_id):
    doc = documents[doc_id]
    if not doc["undo_stack"]:
        raise ValueError("Nothing to undo")
    doc["redo_stack"].append(_snapshot_bytes(doc["pdf"]))
    doc["pdf"].close()
    doc["pdf"] = pikepdf.open(io.BytesIO(doc["undo_stack"].pop()))
    return {"tree": _rebuild_registry(doc_id), **_undo_state(doc)}


def redo_edit(doc_id):
    doc = documents[doc_id]
    if not doc["redo_stack"]:
        raise ValueError("Nothing to redo")
    doc["undo_stack"].append(_snapshot_bytes(doc["pdf"]))
    doc["pdf"].close()
    doc["pdf"] = pikepdf.open(io.BytesIO(doc["redo_stack"].pop()))
    return {"tree": _rebuild_registry(doc_id), **_undo_state(doc)}


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
            elif cmd == "delete_nodes":
                result = delete_nodes(request["docId"], request["nodeIds"])
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
            elif cmd == "save":
                result = save_document(request["docId"], request["path"])
            else:
                raise ValueError(f"Unknown command: {cmd}")
            _send({"id": req_id, "result": result})
        except Exception as exc:  # noqa: BLE001 - report to host, never crash the loop
            _send({"id": req_id, "error": f"{type(exc).__name__}: {exc}"})


if __name__ == "__main__":
    main()
