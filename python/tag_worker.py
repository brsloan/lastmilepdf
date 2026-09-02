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
  - RoleMap and ClassMap (optional StructTreeRoot extras) are not read or
    written. /ParentTree is: it's the reverse of /K - the map a consumer
    follows from a piece of marked content back to the tag that owns it -
    so leaving it alone while rewriting /K would make the two directions
    disagree. _rebuild_after_mutation() regenerates it from the tree after
    every mutating command (see _rebuild_parent_tree), reusing whatever
    /StructParents and /StructParent keys the document already has and
    allocating new ones only where something tagged doesn't have one yet.
    It always writes a flat /Nums, so a document whose /ParentTree arrived
    as a multi-level /Kids number tree is simply converted on first edit.
    Read-only paths (open_document, undo/redo) deliberately skip this, so
    that merely opening a file never modifies it.
  - Every command here mutates the struct tree only - except
    figure_from_rect(), which also *reads* (never writes) a page's content
    stream, to recover where image XObjects are actually placed (see its
    section for why and how); delete_nodes(), which *writes* a narrowly
    scoped edit: the opening BDC operator of each MCID it's unlinking from
    the struct tree gets rewritten to `/Artifact BMC` (see _artifact_leaves/
    _artifact_mcids_on_page), so unlinked content reads as a real PDF
    artifact instead of an orphaned tag when a consumer checks the content
    stream directly, as Acrobat's accessibility Full Check does; and
    split_leaf() (see "content-leaf text splitting" below), which divides one
    MCID's `BDC ... EMC` span into two so each half can be tagged separately.
    Both of those touch content streams in a narrowly scoped, mechanically
    verified way - never a free-form rewrite.
  - Undo/redo works by snapshotting the *entire* pikepdf.Pdf (serialized to
    bytes) before each mutation, rather than recording inverse edits. Simple
    and correct by construction, at the cost of an O(document size) copy per
    edit - acceptable given every edit already rebuilds the whole tree, but
    worth knowing if this ever needs to scale to very large PDFs edited
    rapidly. `MAX_UNDO_DEPTH` bounds how many snapshots we hold onto.
"""

import base64
import io
import json
import re
import sys
import uuid

# main.js writes JSON to this process's stdin as UTF-8 (Node's default
# string encoding) and expects UTF-8 back on stdout. Without this, Python on
# Windows defaults sys.stdin/sys.stdout to the console's ANSI codepage (e.g.
# cp1252) rather than UTF-8, so any non-ASCII character (an em dash, a
# bullet, a curly quote pulled from a PDF's content stream or typed into
# Actual Text) gets silently mis-decoded on the way in - and that already-
# mangled text is what ends up written into the PDF, and mis-encoded again
# on the way back out. Force both streams to UTF-8 as early as possible,
# before any request is read.
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

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
    just from opening them or selecting the /Document tag.

    Also carries a few fields the Verify report needs beyond /Info: the
    catalog's primary /Lang (editable via update_doc_info(), same as
    Title/Author), the /MarkInfo Marked flag (what Acrobat's "Tagged PDF"
    check actually looks at - a StructTreeRoot can exist without this being
    set), and the "extract for accessibility" permission bit - those latter
    two are read-only and not threaded through update_doc_info()."""
    pdf = doc["pdf"]
    info = pdf.trailer.get("/Info")
    title = _get_string(info, "/Title") if isinstance(info, pikepdf.Dictionary) else None
    author = _get_string(info, "/Author") if isinstance(info, pikepdf.Dictionary) else None

    lang = _get_string(pdf.Root, "/Lang")

    mark_info = pdf.Root.get("/MarkInfo")
    marked = bool(
        isinstance(mark_info, pikepdf.Dictionary)
        and mark_info.get("/Marked", False)
    )

    try:
        accessibility_permission = bool(pdf.allow.accessibility)
    except Exception:
        # Unencrypted PDFs (the common case) implicitly allow everything;
        # fail open rather than let a report crash on an odd/legacy file.
        accessibility_permission = True

    return {
        "title": title,
        "author": author,
        "lang": lang,
        "markedTagged": marked,
        "accessibilityPermission": accessibility_permission,
    }


def update_doc_info(doc_id, changes):
    """Sets Title/Author on the PDF's document information dictionary - the
    Tag Properties panel swaps in these fields (in place of Alt/Actual Text)
    when the /Document tag is selected, since that struct element doesn't
    carry meaningful accessibility text of its own.

    Also mirrors the change into XMP (dc:title/dc:creator): Acrobat's
    Document Properties dialog reads Title/Author from XMP whenever an XMP
    stream is present, and ignores /Info entirely in that case, so writing
    only the legacy /Info dict left Acrobat showing stale values.

    "lang" sets the catalog's primary /Lang (the document's overall
    language, per the PDF spec) rather than anything in /Info - the Tag
    Properties panel repurposes the same Language field used for a struct
    element's own /Lang attribute when the /Document tag is selected, since
    that's the one place in the tree that maps onto this document-wide
    setting.

    Setting a title also sets /ViewerPreferences /DisplayDocTitle true on
    the catalog - without it, Acrobat's "Document Title" accessibility check
    fails even though /Title is present, because DisplayDocTitle is what
    tells a viewer to show the title instead of the filename."""
    doc = documents[doc_id]
    _push_undo_snapshot(doc)
    info = doc["pdf"].docinfo
    if "title" in changes:
        _set_or_clear_string(info, "/Title", changes["title"])
        if changes["title"]:
            root = doc["pdf"].Root
            vp = root.get("/ViewerPreferences")
            if not isinstance(vp, pikepdf.Dictionary):
                vp = pikepdf.Dictionary({})
                root["/ViewerPreferences"] = vp
            vp["/DisplayDocTitle"] = True
    if "author" in changes:
        _set_or_clear_string(info, "/Author", changes["author"])
    with doc["pdf"].open_metadata() as meta:
        meta.load_from_docinfo(info, delete_missing=True)
    if "lang" in changes:
        _set_or_clear_string(doc["pdf"].Root, "/Lang", changes["lang"])
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
    that role if it's a content/object-ref leaf. Backs the tag tree's H1-H6,
    'D', 'H', and 'C' shortcuts, plus the table editor's role conversions -
    not the 'I' (List Item) shortcut, which needs convert_to_list_item()'s
    Lbl/LBody handling instead."""
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

    return {"tree": _rebuild_after_mutation(doc_id), **_undo_state(doc)}


# Roles the 'P' shortcut's flatten dissolves rather than preserves, when
# encountered anywhere in a List/Span/Div's subtree - see _paragraphize().
_TRANSPARENT_ROLES = ("L", "Span", "Div", "LI", "Lbl", "LBody")


def _direct_child_ids(doc, node_id):
    """Direct children of node_id, in document order.

    Reads the index _rebuild_registry() builds by inverting parent_map in
    one pass, which preserves document order for the same reason scanning
    parent_map directly used to: _walk() inserts kids left-to-right, and
    dicts keep insertion order. The index matters because the recursive
    callers here (_collect_leaf_ids, _paragraphize_children,
    _first_positioned_descendant) call this once per node they descend
    through - against a full-document scan that made them quadratic in the
    node count."""
    return doc["children_map"].get(node_id, [])


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

    return {"tree": _rebuild_after_mutation(doc_id), **_undo_state(doc)}


def _collect_leaf_ids(doc, node_id):
    """Every content/object-ref leaf anywhere under `node_id`, in document
    order - descends through struct-element children of any role (unlike
    _leaves_through_spans, which only tunnels through Span, or _paragraphize,
    which stops at the first non-transparent role). Used by the 'F' shortcut
    to flatten a converted tag's whole subtree down to just its content
    leaves, discarding whatever structure used to sit between them."""
    leaves = []
    for child_id in _direct_child_ids(doc, node_id):
        if doc["node_kind"].get(child_id) == "element":
            leaves.extend(_collect_leaf_ids(doc, child_id))
        else:
            leaves.append(child_id)
    return leaves


def _kid_for_leaf(doc, leaf_id, container_page):
    """The object to put in a struct element's /K to reference the leaf at
    `leaf_id`, given the element itself resolves to `container_page`.
    Shared by convert_to_figure() and _make_leaf_container() (an LI's
    Lbl/LBody) - both collapse a subtree of arbitrary depth down to its
    leaves and regroup them under one or more new containers.

    Usually that's just the leaf itself. The exception is a bare MCID
    coming from a different page: it's a plain integer with no dict of its
    own to carry /Pg, so it resolves against whatever page its *containing*
    element does (see the module docstring). Collapsing a subtree that
    spans a page break - which _collect_leaf_ids() happily does, since it
    descends through struct elements of any role and any /Pg - would
    therefore silently repoint every later-page leaf at the container's
    page. That's not a cosmetic mislabel: those MCIDs then name whatever
    marked content happens to share their numbers on the container's page
    (already owned by other tags, since MCIDs restart per page), while the
    content they actually came from is left referenced by nothing at all.

    reorder_node() refuses this move outright rather than corrupt the tree
    that way. Here we can do better than refuse, because an /MCR carries
    its own /Pg and so isn't bound to its parent's page: promote just the
    off-page bare MCIDs to /MCR and they keep pointing exactly where they
    always did. Everything already on the container's page - which is
    every leaf in the ordinary single-page case - is returned untouched,
    so that path is unchanged."""
    obj = doc["elements"][leaf_id]
    if doc["node_kind"].get(leaf_id) != "content-int":
        return obj  # /MCR and /OBJR already carry their own /Pg
    page = doc["node_pages"].get(leaf_id)
    if page is None or page == container_page:
        return obj  # inherits the right page anyway
    return pikepdf.Dictionary({
        "/Type": pikepdf.Name("/MCR"),
        "/Pg": doc["pdf"].pages[page].obj,
        "/MCID": int(obj),
    })


def convert_to_figure(doc_id, node_ids):
    """Converts each selected tag to a Figure. A Figure is expected to hold
    its content directly rather than through nested structure, so a
    converted struct element has its whole subtree collapsed first (see
    _collect_leaf_ids): every content/object-ref leaf under it becomes a
    direct child, and every struct element in between - along with whatever
    else it held, like a discarded List's dissolved LIs - is simply dropped
    from the tree. A content/object-ref leaf selected on its own is just
    wrapped in a new Figure, same as set_role_or_wrap() handles H1-H6/LI (a
    single leaf is already "just the content leaves"). Backs the tag tree's
    'F' shortcut."""
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
            elem = doc["elements"][node_id]
            leaf_ids = _collect_leaf_ids(doc, node_id)
            elem["/S"] = pikepdf.Name("/Figure")
            if leaf_ids:
                # Resolve the Figure's own page first: it decides which
                # leaves inherit the right page as-is and which have to
                # carry their own - see _kid_for_leaf().
                page_index = doc["node_pages"].get(leaf_ids[0])
                if page_index is not None:
                    elem["/Pg"] = doc["pdf"].pages[page_index].obj
                leaf_objs = [_kid_for_leaf(doc, lid, page_index) for lid in leaf_ids]
                elem["/K"] = leaf_objs[0] if len(leaf_objs) == 1 else pikepdf.Array(leaf_objs)
            elif "/K" in elem:
                del elem["/K"]
        else:
            _wrap_leaf(doc, node_id, "Figure")

    return {"tree": _rebuild_after_mutation(doc_id), **_undo_state(doc)}


def _leaf_ids_for_li_source(doc, node_id):
    """The ordered leaf ids that become an LI's content when `node_id`
    itself is converted into (or wrapped in) that LI: every content/
    object-ref leaf under it, per _collect_leaf_ids, if it's a struct
    element - or just itself, if it's already a bare leaf."""
    if doc["node_kind"].get(node_id) == "element":
        return _collect_leaf_ids(doc, node_id)
    return [node_id]


def _make_leaf_container(doc, role, leaf_ids):
    """A new, not-yet-attached struct element with role `role` wrapping
    every leaf in `leaf_ids` (already in document order) under one /K, with
    /Pg taken from the first leaf - the same shape _make_paragraph() builds
    for /P - or left with neither /Pg nor /K if `leaf_ids` is empty. Used to
    build an LI's Lbl and LBody; see _set_li_content()."""
    elem = doc["pdf"].make_indirect(pikepdf.Dictionary({
        "/Type": pikepdf.Name("/StructElem"),
        "/S": pikepdf.Name("/" + role),
    }))
    if not leaf_ids:
        return elem
    page = doc["node_pages"].get(leaf_ids[0])
    if page is not None:
        elem["/Pg"] = doc["pdf"].pages[page].obj
    leaf_objs = [_kid_for_leaf(doc, lid, page) for lid in leaf_ids]
    elem["/K"] = leaf_objs[0] if len(leaf_objs) == 1 else pikepdf.Array(leaf_objs)
    return elem


def _set_li_content(doc, li_elem, leaf_ids, use_label):
    """Populates `li_elem`'s /K from `leaf_ids` (already in document
    order): when `use_label` is set, the first leaf becomes a Lbl and every
    remaining leaf (possibly none) becomes an LBody, so the split always
    leaves the LI with a predictable Lbl+LBody pair; otherwise every leaf
    goes into a single LBody. An empty `leaf_ids` means there's nothing to
    label or hold, so /K is cleared instead.

    `use_label` is decided by the caller - renderer.js's
    collectTargetMcids()/resolveMcidText(), since this backend has no text
    extraction of its own - by checking whether the first leaf's own text is
    just a bullet, a single letter followed by a period, or digits followed
    by a period. Shared by the 'L' and 'I' shortcuts (make_list(),
    convert_to_list_item())."""
    if not leaf_ids:
        if "/K" in li_elem:
            del li_elem["/K"]
        return

    if use_label:
        lbl = _make_leaf_container(doc, "Lbl", leaf_ids[:1])
        body = _make_leaf_container(doc, "LBody", leaf_ids[1:])
        lbl["/P"] = li_elem
        body["/P"] = li_elem
        li_elem["/K"] = pikepdf.Array([lbl, body])
    else:
        body = _make_leaf_container(doc, "LBody", leaf_ids)
        body["/P"] = li_elem
        li_elem["/K"] = body


def _group_into_container(doc_id, node_ids, container_role, item_role, preserved_roles, cant_group_msg):
    """Shared shape behind the 'T'/'R' shortcuts: groups the selected tags
    into a newly created container struct element (Table/TR). Each selected
    node becomes a child with role `item_role` - a struct element is
    relabeled in place (unless its current role is already in
    `preserved_roles`, in which case it's left untouched); a content/
    object-ref leaf is wrapped in a brand-new element with role `item_role`,
    same as set_role_or_wrap() does for H1-H6 (a leaf has no role of its
    own, so it's never eligible for `preserved_roles`). The container lands
    at the position the earliest-selected item occupied. Every selected node
    must currently share the same parent - there'd be no single
    well-defined "where the first item was" otherwise. The 'L' shortcut
    (make_list()) used to share this too, but now needs its own version
    since a list item's content always gets rebuilt into the Lbl/LBody
    split - see _set_li_content()."""
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

    return {"tree": _rebuild_after_mutation(doc_id), **_undo_state(doc)}


def make_list(doc_id, node_ids, label_flags):
    """Groups the selected tags into a newly created List: each one becomes
    an LI whose own content is rebuilt from its collapsed leaves (see
    _leaf_ids_for_li_source), split into a Lbl+LBody pair or a single LBody
    per `label_flags` (see _set_li_content) - unlike make_table()/make_tr()
    (_group_into_container), an item here is never just relabeled in place,
    since a list item always ends up in the Lbl/LBody shape regardless of
    whatever structure it had before. The container otherwise lands at the
    position the earliest-selected item occupied, and every selected node
    must currently share the same parent, the same as
    _group_into_container(). Backs the tag tree's 'L' shortcut."""
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
        raise ValueError("Can't group into a list: selected tags don't share a parent.")
    parent_id = next(iter(parent_ids))
    parent_obj = doc["elements"][parent_id]

    # Document order among the selected nodes, as they currently sit among
    # their shared parent's kids - see _top_level_selection for why this
    # parent_map scan preserves kid order.
    node_id_set = set(node_ids)
    ordered_ids = [cid for cid, pid in doc["parent_map"].items() if pid == parent_id and cid in node_id_set]

    item_objs = [doc["elements"][nid] for nid in ordered_ids]
    first_index = min(_kid_index(parent_obj, obj) for obj in item_objs)
    if first_index == -1:
        raise ValueError("Could not locate selected tags in their parent")

    # Collected before anything is mutated - an item's leaves have to be
    # read out of the tree it's still sitting in.
    leaf_ids_by_node = {nid: _leaf_ids_for_li_source(doc, nid) for nid in ordered_ids}

    _push_undo_snapshot(doc)

    li_elems = []
    for node_id in ordered_ids:
        obj = doc["elements"][node_id]
        _remove_kid(parent_obj, obj)
        if doc["node_kind"].get(node_id) == "element":
            li = obj
            li["/S"] = pikepdf.Name("/LI")
        else:
            li = doc["pdf"].make_indirect(pikepdf.Dictionary({
                "/Type": pikepdf.Name("/StructElem"),
                "/S": pikepdf.Name("/LI"),
            }))
        _set_li_content(doc, li, leaf_ids_by_node[node_id], bool(label_flags.get(node_id)))
        li_elems.append(li)

    new_list = doc["pdf"].make_indirect(pikepdf.Dictionary({
        "/Type": pikepdf.Name("/StructElem"),
        "/S": pikepdf.Name("/L"),
        "/P": parent_obj,
    }))
    for li in li_elems:
        li["/P"] = new_list
    new_list["/K"] = pikepdf.Array(li_elems)

    _insert_kid(parent_obj, new_list, first_index)

    return {"tree": _rebuild_after_mutation(doc_id), **_undo_state(doc)}


def convert_to_list_item(doc_id, node_ids, label_flags):
    """Converts each selected tag to an LI, the same way set_role_or_wrap()
    handles H1-H6 - a struct element relabeled to /LI in place, a content/
    object-ref leaf wrapped in a brand-new /LI - except an LI's content is
    always rebuilt from its own collapsed leaves (see
    _leaf_ids_for_li_source) into the Lbl/LBody split (see _set_li_content)
    per `label_flags`, discarding whatever nested structure it had before.
    Because that collapse can remove struct elements from the tree, a
    selection covering both an ancestor and its own descendant is narrowed
    to just the ancestor first (see _top_level_selection), the same as
    convert_to_figure()/convert_to_paragraph(). Backs the tag tree's 'I'
    shortcut."""
    doc = documents[doc_id]
    if not node_ids:
        raise ValueError("No tags selected")
    for node_id in node_ids:
        if node_id == "root":
            raise ValueError("Cannot convert the document root")
        if node_id not in doc["elements"]:
            raise ValueError(f"Unknown node id: {node_id}")

    top_level = _top_level_selection(doc, node_ids)
    leaf_ids_by_node = {nid: _leaf_ids_for_li_source(doc, nid) for nid in top_level}

    _push_undo_snapshot(doc)
    for node_id in top_level:
        use_label = bool(label_flags.get(node_id))
        leaf_ids = leaf_ids_by_node[node_id]
        if doc["node_kind"].get(node_id) == "element":
            elem = doc["elements"][node_id]
            elem["/S"] = pikepdf.Name("/LI")
            _set_li_content(doc, elem, leaf_ids, use_label)
        else:
            li = _wrap_leaf(doc, node_id, "LI")
            _set_li_content(doc, li, leaf_ids, use_label)

    return {"tree": _rebuild_after_mutation(doc_id), **_undo_state(doc)}


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


def _content_owners(doc):
    """Reverse of the /K walk: who owns each piece of marked content, as
    ({page_index: {mcid: owning_elem}}, [(objr_target, owning_elem), ...]).
    Built from the registry, so it reflects the tree exactly as it stands
    after the mutation that just ran."""
    per_page = {}
    per_object = []
    for node_id, kind in doc["node_kind"].items():
        if kind not in ("content-int", "content-dict"):
            continue
        parent_id = doc["parent_map"].get(node_id)
        owner = doc["elements"].get(parent_id) if parent_id is not None else None
        if not isinstance(owner, pikepdf.Dictionary):
            continue
        obj = doc["elements"][node_id]
        page = doc["node_pages"].get(node_id)
        if kind == "content-int":
            if page is not None:
                per_page.setdefault(page, {})[int(obj)] = owner
            continue
        if str(obj.get("/Type")) == "/OBJR":
            target = obj.get("/Obj")
            if isinstance(target, (pikepdf.Dictionary, pikepdf.Stream)):
                per_object.append((target, owner))
        elif "/MCID" in obj and page is not None:
            try:
                per_page.setdefault(page, {})[int(obj["/MCID"])] = owner
            except (TypeError, ValueError):
                pass
    return per_page, per_object


def _rebuild_parent_tree(doc):
    """Rewrites /StructTreeRoot's /ParentTree from the tree as it now
    stands.

    /ParentTree is the reverse of /K: it maps a piece of marked content
    back to the struct element that owns it, keyed by the page's
    /StructParents (an array indexed by MCID) or by an object's own
    /StructParent (a single element, for content reached via /OBJR). It's
    what a consumer uses to go from content to structure - the direction
    that answers "which tag does this text belong to?".

    Nothing here used to maintain it, so every command that re-parented or
    dropped a leaf left the two directions disagreeing: /K said one thing,
    /ParentTree still named whichever element owned that content before the
    edit, including elements no longer anywhere in the tree.

    Rebuilding wholesale (rather than patching entries) is the same trade
    _rebuild_registry() already makes, and for the same reason: it's
    correct by construction, and the cost is bounded by document size on an
    operation that already re-walks the whole tree.

    Existing /StructParents and /StructParent keys are reused wherever a
    page or object already has one - they're referenced from the page and
    object dictionaries, and renumbering them on every edit would rewrite
    every page object for no benefit. Only a page or object that owns
    tagged content without a key yet gets a freshly allocated one.

    The result is always written as a flat /Nums. That's a valid number
    tree whatever the input used, which is what lets figure_from_rect()
    stop refusing documents whose /ParentTree came as a multi-level /Kids
    tree."""
    pdf = doc["pdf"]
    struct_root = doc["elements"]["root"]
    per_page, per_object = _content_owners(doc)

    used_keys = set()
    for page in pdf.pages:
        existing = page.obj.get("/StructParents")
        if existing is not None:
            try:
                used_keys.add(int(existing))
            except (TypeError, ValueError):
                pass
    for target, _owner in per_object:
        existing = target.get("/StructParent")
        if existing is not None:
            try:
                used_keys.add(int(existing))
            except (TypeError, ValueError):
                pass

    next_key = max(used_keys) + 1 if used_keys else 0
    try:
        declared = int(struct_root.get("/ParentTreeNextKey"))
        next_key = max(next_key, declared)
    except (TypeError, ValueError):
        pass

    def allocate():
        nonlocal next_key
        key = next_key
        next_key += 1
        return key

    entries = {}  # key -> value object

    for page_index, page in enumerate(pdf.pages):
        owners = per_page.get(page_index)
        key = page.obj.get("/StructParents")
        try:
            key = int(key) if key is not None else None
        except (TypeError, ValueError):
            key = None
        if key is None:
            if not owners:
                continue  # nothing tagged on this page and no key to honour
            key = allocate()
            page.obj["/StructParents"] = key
        # A page that has a key keeps an entry even with nothing tagged on
        # it any more (everything on it was artifacted), so its
        # /StructParents doesn't dangle into a missing key.
        size = max(owners) + 1 if owners else 0
        entries[key] = pikepdf.Array([
            owners.get(mcid) if owners else None for mcid in range(size)
        ])

    for target, owner in per_object:
        key = target.get("/StructParent")
        try:
            key = int(key) if key is not None else None
        except (TypeError, ValueError):
            key = None
        if key is None:
            key = allocate()
            target["/StructParent"] = key
        entries[key] = owner

    nums = []
    for key in sorted(entries):
        nums.append(key)
        nums.append(entries[key])

    parent_tree = struct_root.get("/ParentTree")
    if isinstance(parent_tree, pikepdf.Dictionary):
        if "/Kids" in parent_tree:
            del parent_tree["/Kids"]  # replaced wholesale by the flat /Nums below
        parent_tree["/Nums"] = pikepdf.Array(nums)
    else:
        struct_root["/ParentTree"] = pdf.make_indirect(
            pikepdf.Dictionary({"/Nums": pikepdf.Array(nums)})
        )
    struct_root["/ParentTreeNextKey"] = next_key


def _rebuild_after_mutation(doc_id):
    """What every mutating command returns its tree from: re-index the tree
    (assigning fresh node ids), then bring /ParentTree back in line with it.
    Read-only paths - open_document(), and undo/redo, whose snapshots
    already carry a consistent /ParentTree - use _rebuild_registry()
    directly so that merely opening a file never modifies it."""
    tree = _rebuild_registry(doc_id)
    doc = documents[doc_id]
    if doc["elements"].get("root") is not None:
        _rebuild_parent_tree(doc)
    return tree


def _rebuild_registry(doc_id):
    doc = documents[doc_id]
    doc["elements"] = {}
    doc["parent_map"] = {}
    doc["node_pages"] = {}
    doc["node_kind"] = {}
    doc["children_map"] = {}
    doc["counter"] = 0
    # An untagged PDF has no tree to walk. Every tag-editing command fails
    # long before it reaches here (there's no node id for the caller to
    # name in the first place), but undo_edit()/redo_edit() run against any
    # open document - bookmark and document-info edits are available on an
    # untagged PDF too, and both push undo snapshots - so this has to
    # report "no tree" as a None the caller can pass straight through,
    # rather than a KeyError that aborts the undo *after* it has already
    # swapped doc["pdf"] for the restored snapshot (leaving the host
    # showing pre-undo state for a document that has actually moved).
    if "/StructTreeRoot" not in doc["pdf"].Root:
        return None
    struct_root = doc["pdf"].Root["/StructTreeRoot"]
    doc["elements"]["root"] = struct_root
    tree = _walk(doc, struct_root, "root")
    # Invert parent_map once, rather than re-scanning it per node in
    # _direct_child_ids(). parent_map is populated in _walk's own
    # left-to-right order, so grouping it preserves document order.
    for child_id, parent_id in doc["parent_map"].items():
        doc["children_map"].setdefault(parent_id, []).append(child_id)
    return tree


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


def _find_bookmark_insert_slot(doc, items, page):
    """Where a new bookmark targeting `page` belongs within `items` (an
    Outline's .root, or an OutlineItem's .children), keeping the outline in
    page order: the slot right after the last item at this level whose own
    page is <= `page` (items with no resolvable page are skipped, neither
    advancing nor blocking that search), or the start of `items` if none
    qualify. When that anchor item has children, the target may belong
    among them instead - e.g. a new page-12 bookmark should land inside an
    existing "Chapter 2, pages 10-20" bookmark's children, not after all of
    them - so the search recurses into its children and only bottoms out
    (returning a slot in `items` itself) once an anchor has none. Returns
    (containing_list, index)."""
    last_le = None
    for i, item in enumerate(items):
        item_page = _outline_item_page(doc, item)
        if item_page is None:
            continue
        if item_page <= page:
            last_le = i
        else:
            break
    if last_le is None:
        return items, 0
    candidate = items[last_le]
    if candidate.children:
        return _find_bookmark_insert_slot(doc, candidate.children, page)
    return items, last_le + 1


def add_bookmark(doc_id, page, title):
    """Adds a new bookmark titled `title` pointing at `page` (0-based),
    inserted wherever it belongs by page order (see
    _find_bookmark_insert_slot()) rather than relative to any selection.
    Backs the Bookmarks panel's + button, which points the new bookmark at
    whatever page is currently open in the preview."""
    doc = documents[doc_id]
    item = pikepdf.OutlineItem(title or "Untitled", page)

    _push_undo_snapshot(doc)
    with doc["pdf"].open_outline() as outline:
        containing_list, insert_at = _find_bookmark_insert_slot(doc, outline.root, page)
        containing_list.insert(insert_at, item)

        id_map = {}
        _walk_outline(doc, outline.root, [0], id_map)
        new_id = next(nid for nid, obj in id_map.items() if obj is item)

    return {"outline": _get_outline_tree(doc), "newBookmarkId": new_id, **_undo_state(doc)}


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
        "node_kind": {}, "children_map": {}, "counter": 0,
        "page_index_by_objgen": {page.objgen: i for i, page in enumerate(pdf.pages)},
        "undo_stack": [], "redo_stack": [],
    }
    doc = documents[doc_id]
    outline_tree = _get_outline_tree(doc)
    doc_info = _get_doc_info(doc)

    # _rebuild_registry() is itself the "is this document tagged?" test (it
    # returns None when there's no /StructTreeRoot), so derive hasStructTree
    # from it rather than checking pdf.Root separately here - two copies of
    # that condition are exactly what let undo/redo drift into raising on
    # untagged documents.
    tree = _rebuild_registry(doc_id)
    return {
        "docId": doc_id, "hasStructTree": tree is not None, "tree": tree,
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

    return {"tree": _rebuild_after_mutation(doc_id), **_undo_state(doc)}


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

    return {"tree": _rebuild_after_mutation(doc_id), **_undo_state(doc)}


def update_actual_texts(doc_id, updates):
    """Bulk-sets /ActualText to a *different* value per node, as one undo
    step - unlike update_nodes() above, which applies one shared `changes`
    to every listed node. Used by "Fix All Actual Text (AI)": every tag the
    AI corrected is written in a single action, so one Undo reverts the
    whole batch rather than requiring one Undo per tag."""
    doc = documents[doc_id]
    targets = []
    for node_id, text in updates.items():
        if node_id == "root":
            raise ValueError("The document root has no editable attributes")
        if node_id not in doc["elements"]:
            raise ValueError(f"Unknown node id: {node_id}")
        if doc["node_kind"].get(node_id) != "element":
            raise ValueError("Content leaves have no editable attributes")
        targets.append((doc["elements"][node_id], text))
    if not targets:
        raise ValueError("No nodes to update")

    _push_undo_snapshot(doc)
    for elem, text in targets:
        _set_or_clear_string(elem, "/ActualText", text)

    return {"tree": _rebuild_after_mutation(doc_id), **_undo_state(doc)}


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

    return {"tree": _rebuild_after_mutation(doc_id), **_undo_state(doc)}


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

    return {"tree": _rebuild_after_mutation(doc_id), **_undo_state(doc)}


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

    return {"tree": _rebuild_after_mutation(doc_id), **_undo_state(doc)}


def _is_organizational_role(role):
    """True for the PDF standard grouping/organizational struct types (Div,
    Sect, Part, Span) - tags that exist purely to wrap other content rather
    than to describe it - plus any custom type whose name contains "span"
    (to catch vendor-specific inline-span variants some generators emit
    under their own namespaced names). Matched case-insensitively since
    casing on custom types isn't guaranteed."""
    if not role:
        return False
    lowered = role.lower()
    if lowered in ("div", "sect", "part", "span"):
        return True
    return "span" in lowered


def _count_organizational_tags(struct_obj):
    count = 0
    for kid in _iter_kids(struct_obj):
        if isinstance(kid, pikepdf.Dictionary) and "/S" in kid:
            if _is_organizational_role(str(kid["/S"]).lstrip("/")):
                count += 1
            count += _count_organizational_tags(kid)
    return count


def _flatten_organizational_tags(struct_obj):
    """Recursively removes organizational struct elements (see
    _is_organizational_role) from struct_obj's subtree, splicing each one's
    own kids into its parent's /K in its place (so their contents are kept,
    just un-nested by one level). Mutates /K on every ancestor whose kids
    changed, and reparents (/P) any surviving struct-element grandkids to
    their new direct parent. struct_obj itself is never removed, even if it
    is itself organizational - only what's nested inside it is flattened."""
    changed = False
    new_kids = []
    for kid in _iter_kids(struct_obj):
        if isinstance(kid, pikepdf.Dictionary) and "/S" in kid:
            _flatten_organizational_tags(kid)  # post-order: flatten nested ones first
            if _is_organizational_role(str(kid["/S"]).lstrip("/")):
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


def flatten_tags(doc_id, node_ids):
    """For each selected tag, recursively removes organizational tags (Div,
    Sect, Part, Span, and Span-like custom types - see
    _is_organizational_role) found within its subtree, keeping every
    content leaf and non-organizational struct element in place, just
    un-nested by however many wrapping levels get removed. A selected tag
    is never itself removed, even if it's organizational - only what's
    nested inside it is flattened. Backs the tag tree's Flatten action
    (replaces the old whole-document Kill Divs)."""
    doc = documents[doc_id]
    if not node_ids:
        raise ValueError("No tags selected")
    for node_id in node_ids:
        if node_id != "root" and node_id not in doc["elements"]:
            raise ValueError(f"Unknown node id: {node_id}")

    top_level = _top_level_selection(doc, node_ids)
    targets = [
        nid for nid in top_level
        if nid == "root" or doc["node_kind"].get(nid) == "element"
    ]

    removed = sum(_count_organizational_tags(doc["elements"][nid]) for nid in targets)
    if removed == 0:
        return {"tree": _rebuild_registry(doc_id), "removed": 0, **_undo_state(doc)}

    _push_undo_snapshot(doc)
    for nid in targets:
        _flatten_organizational_tags(doc["elements"][nid])
    return {"tree": _rebuild_after_mutation(doc_id), "removed": removed, **_undo_state(doc)}


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

    return {"tree": _rebuild_after_mutation(doc_id), "tablesScoped": scoped, **_undo_state(doc)}


def _content_leaves_under(doc, node_id):
    """`node_id` itself if it's already a content/object-ref leaf, otherwise
    every such leaf anywhere under it (via _collect_leaf_ids). What
    delete_nodes() needs artifacted isn't just the node the caller selected -
    deleting a struct element takes its whole subtree with it, and every
    piece of marked content in that subtree is about to be orphaned from the
    struct tree exactly the same way a directly-selected leaf is."""
    if doc["node_kind"].get(node_id) != "element":
        return [node_id]
    return _collect_leaf_ids(doc, node_id)


def _artifact_leaves(doc, leaf_ids):
    """Turns each of `leaf_ids` - content/object-ref leaves about to be
    unlinked from the struct tree by delete_nodes() - into a real PDF
    artifact, not just an orphaned struct-tree reference.

    Unlinking a leaf from its parent's /K was, until this function existed,
    treated as sufficient: the comment used to justify it read "assistive
    tech skips unreferenced content exactly as it would a real /Artifact
    tag." That's not true of Acrobat's accessibility Full Check, and isn't
    guaranteed of any consumer: this editor never rewrites content-stream
    marked-content operators (see the module docstring), so a bare-MCID or
    /MCR leaf's `/Figure BDC <</MCID 32>>` (or whatever role it had) is
    still sitting in the page's content stream afterward, still naming that
    role, still carrying that MCID. A checker that reads the content stream
    directly - which Acrobat's does - finds a live tagged region with no
    structure element claiming it and fails it (observed as "Other elements
    ... alternate text -- failed", invisible in the Tags panel but visible
    in the Content panel's raw marked-content view). PDF/UA only recognizes
    content as an artifact when the content stream itself says so, via
    `/Artifact BMC`/`BDC` - so that's what a targeted leaf's opening BDC
    operator is rewritten to here.

    An /OBJR leaf (an image XObject or annotation referenced directly, never
    wrapped in marked content - see the module docstring) has no BDC/EMC to
    rewrite, but may carry its own /StructParent key pointing into
    /ParentTree; that key is left dangling by an ordinary unlink the same
    way an MCID is, so it's cleared here too.

    Every mcid target is grouped by page first, so each page's content
    stream is parsed and rewritten exactly once no matter how many leaves on
    it are being artifacted in this call."""
    mcids_by_page = {}  # page_index -> set of mcid
    objr_targets = []

    for leaf_id in leaf_ids:
        kind = doc["node_kind"].get(leaf_id)
        if kind == "content-int":
            page = doc["node_pages"].get(leaf_id)
            if page is not None:
                mcids_by_page.setdefault(page, set()).add(int(doc["elements"][leaf_id]))
        elif kind == "content-dict":
            obj = doc["elements"][leaf_id]
            if str(obj.get("/Type")) == "/OBJR":
                target = obj.get("/Obj")
                if isinstance(target, (pikepdf.Dictionary, pikepdf.Stream)):
                    objr_targets.append(target)
            elif "/MCID" in obj:
                page = doc["node_pages"].get(leaf_id)
                if page is not None:
                    try:
                        mcids_by_page.setdefault(page, set()).add(int(obj["/MCID"]))
                    except (TypeError, ValueError):
                        pass

    for page_index, mcids in mcids_by_page.items():
        _artifact_mcids_on_page(doc, page_index, mcids)

    for target in objr_targets:
        if "/StructParent" in target:
            del target["/StructParent"]


def _artifact_mcids_on_page(doc, page_index, mcids):
    """Rewrites every top-level `<role> BDC <</MCID n>>` on `page_index`
    whose `n` is in `mcids` to a plain `/Artifact BMC` - same tag name every
    real artifact in a PDF/UA-conforming file uses, and the same one this
    editor's other commands leave alone (they never touch content streams -
    this is the one deliberate, narrowly-targeted exception, only ever
    turning a specific already-selected-for-deletion MCID into an artifact,
    never adding, removing, or reordering any actual drawing operator).

    The matching EMC needs no change: it carries no operands, so the same
    token closes a BMC block exactly as it closed the BDC block it used to.
    A page whose content stream can't be parsed is left as-is - the
    struct-tree unlink still happens, same as if this function didn't
    exist, so this can only add a fix on top of the old behavior, never
    remove one."""
    pdf = doc["pdf"]
    if page_index < 0 or page_index >= len(pdf.pages):
        return
    page = pdf.pages[page_index]
    page.contents_coalesce()
    try:
        instructions = pikepdf.parse_content_stream(page)
    except Exception:
        return

    changed = False
    rewritten = []
    for instr in instructions:
        mcid = None
        if str(instr.operator) == "BDC" and len(instr.operands) == 2:
            props = instr.operands[1]
            if isinstance(props, pikepdf.Dictionary) and "/MCID" in props:
                try:
                    mcid = int(props["/MCID"])
                except (TypeError, ValueError):
                    mcid = None
        if mcid is not None and mcid in mcids:
            rewritten.append(pikepdf.ContentStreamInstruction(
                [pikepdf.Name("/Artifact")], pikepdf.Operator("BMC")
            ))
            changed = True
        else:
            rewritten.append(instr)

    if changed:
        page.obj.Contents.write(pikepdf.unparse_content_stream(rewritten))


def _find_orphaned_mcids(page, claimed_mcids):
    """Every MCID `page`'s own content stream marks via a non-/Artifact BDC
    operator that isn't a key in `claimed_mcids` - i.e. content the stream
    itself says is tagged (it names a real role and carries an MCID) but
    that the struct tree, as it stands right now, doesn't claim for this
    page. Read-only: only reports what repair_orphaned_marked_content()
    would need to fix, via a later call to _artifact_mcids_on_page."""
    try:
        instructions = pikepdf.parse_content_stream(page)
    except Exception:
        return set()

    orphans = set()
    for instr in instructions:
        if str(instr.operator) != "BDC" or len(instr.operands) != 2:
            continue
        tag, props = instr.operands
        if str(tag) == "/Artifact":
            continue
        if not isinstance(props, pikepdf.Dictionary) or "/MCID" not in props:
            continue
        try:
            mcid = int(props["/MCID"])
        except (TypeError, ValueError):
            continue
        if mcid not in claimed_mcids:
            orphans.add(mcid)
    return orphans


def repair_orphaned_marked_content(doc_id):
    """One-off repair pass for PDFs already damaged by the bug
    _artifact_leaves/_artifact_mcids_on_page now prevents: older versions of
    delete_nodes() (and the Smartifact tool, which is backed by it) unlinked
    a leaf from the struct tree without rewriting its content-stream BDC
    operator, leaving marked content that still names a real struct role
    (commonly /Figure, for a "smartified" full-page scan) with an MCID no
    structure element claims any more. That reads fine in this editor and
    in the Tags panel - nothing there ever walked the raw content stream -
    but Acrobat's accessibility Full Check does read it directly, finds a
    live tagged region with no owner, and fails it (the "Other elements ...
    alternate text -- failed" report, visible in Acrobat's Content panel,
    invisible in its Tags panel - see the module docstring's delete_nodes()
    entry for the full mechanism).

    Compares what each page's content stream actually marks against what
    the struct tree currently claims for that page (_content_owners, the
    same reverse index _rebuild_parent_tree uses) - anything marked but
    unclaimed is exactly this bug's leftovers, and gets converted to a real
    /Artifact the same way a fresh delete already does. A document with no
    struct tree at all has nothing to compare against, so it's rejected
    up front rather than silently doing nothing."""
    doc = documents[doc_id]
    if doc["elements"].get("root") is None:
        raise ValueError("Document has no structure tree to repair")

    per_page, _ = _content_owners(doc)
    orphans_by_page = {}
    for page_index, page in enumerate(doc["pdf"].pages):
        claimed = per_page.get(page_index, {})
        orphans = _find_orphaned_mcids(page, claimed)
        if orphans:
            orphans_by_page[page_index] = orphans

    if not orphans_by_page:
        return {"tree": _rebuild_registry(doc_id), "repairedCount": 0, **_undo_state(doc)}

    _push_undo_snapshot(doc)
    repaired_count = 0
    for page_index, mcids in orphans_by_page.items():
        _artifact_mcids_on_page(doc, page_index, mcids)
        repaired_count += len(mcids)

    return {"tree": _rebuild_after_mutation(doc_id), "repairedCount": repaired_count, **_undo_state(doc)}


def delete_nodes(doc_id, node_ids):
    """Removes each of `node_ids` from its parent's /K, taking its entire
    subtree with it. Backs the tag tree's Delete key for both cases it
    handles: a struct element ("tag") is fully removed along with its
    descendants, and a content/object-ref leaf is unlinked from the struct
    tree the same way - and, since that unlink alone isn't enough to read as
    an artifact to a consumer that checks the content stream (see
    _artifact_leaves), every leaf involved - the directly-selected one, or
    any pulled in by deleting an ancestor - has its underlying content
    turned into a real /Artifact first."""
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

    leaf_ids = []
    for node_id in top_level:
        leaf_ids.extend(_content_leaves_under(doc, node_id))
    _artifact_leaves(doc, leaf_ids)

    for node_id in top_level:
        node_obj = doc["elements"][node_id]
        parent_id = doc["parent_map"].get(node_id)
        parent_obj = doc["elements"].get(parent_id) if parent_id is not None else None
        if parent_obj is not None:
            _remove_kid(parent_obj, node_obj)

    return {"tree": _rebuild_after_mutation(doc_id), **_undo_state(doc)}


def join_tags(doc_id, node_ids):
    """Backs the tag tree's 'J' shortcut: merges tag(s) into an earlier tag,
    moving every child onto the end of the target's own /K in document
    order, then removing the now-empty source tag(s) entirely.

    With a single tag selected, there's no second selected tag to serve as
    the target, so the target is that tag's own previous sibling. With
    several selected, they must all share a parent - same restriction
    make_list()/_group_into_container() apply, for the same reason: there'd
    be no single well-defined "first" otherwise - and the earliest of them
    in document order is the target, with every other selected tag's
    children merged into it in that same order.

    Only struct elements ("tags") can be a source or target here - a
    content/object-ref leaf has no /K of its own to merge into or out of.
    The target keeps its own node id afterward: nothing before it in
    document order changes, and ids are assigned by depth-first position
    (see _rebuild_after_mutation), so its slot in that ordering is
    untouched by removing tags that only ever sat after it."""
    doc = documents[doc_id]
    if not node_ids:
        raise ValueError("No tags selected")

    top_level = _top_level_selection(doc, list(node_ids))
    for node_id in top_level:
        if node_id == "root":
            raise ValueError("Cannot join the document root")
        if node_id not in doc["elements"]:
            raise ValueError(f"Unknown node id: {node_id}")
        if doc["node_kind"].get(node_id) != "element":
            raise ValueError("Can only join tags, not content")

    if len(top_level) == 1:
        node_id = top_level[0]
        parent_id = doc["parent_map"].get(node_id)
        if parent_id is None:
            raise ValueError("Tag has no parent to join into")
        siblings = _direct_child_ids(doc, parent_id)
        idx = siblings.index(node_id)
        if idx == 0:
            raise ValueError("No previous tag to join into")
        target_id = siblings[idx - 1]
        source_ids = [node_id]
    else:
        parent_ids = {doc["parent_map"].get(nid) for nid in top_level}
        if len(parent_ids) != 1 or None in parent_ids:
            raise ValueError("Can't join: selected tags don't share a parent.")
        parent_id = next(iter(parent_ids))
        # Document order among the selected nodes, as they currently sit
        # among their shared parent's kids - see _top_level_selection for
        # why this parent_map scan preserves kid order.
        node_id_set = set(top_level)
        ordered_ids = [cid for cid, pid in doc["parent_map"].items() if pid == parent_id and cid in node_id_set]
        target_id = ordered_ids[0]
        source_ids = ordered_ids[1:]

    if doc["node_kind"].get(target_id) != "element":
        raise ValueError("Can only join into a tag, not content")

    # Bail before mutating anything if moving a bare MCID leaf (whose page
    # is inherited from its containing element - see the module docstring)
    # out of a source tag into a target on a different page would silently
    # mislabel which page it points at - same restriction reorder_node()/
    # reorder_many() apply to a plain move.
    target_page = doc["node_pages"].get(target_id)
    for src_id in source_ids:
        for child_id in _direct_child_ids(doc, src_id):
            if doc["node_kind"].get(child_id) == "content-int" and doc["node_pages"].get(child_id) != target_page:
                raise ValueError("Can't join: marked content would move to a tag on a different page")

    _push_undo_snapshot(doc)
    target_obj = doc["elements"][target_id]

    for src_id in source_ids:
        src_obj = doc["elements"][src_id]
        moved = _iter_kids(src_obj)
        if "/K" in src_obj:
            del src_obj["/K"]

        insertion_index = len(_iter_kids(target_obj))
        for child_obj in moved:
            _insert_kid(target_obj, child_obj, insertion_index)
            if isinstance(child_obj, pikepdf.Dictionary):
                child_obj["/P"] = target_obj
            insertion_index += 1

        src_parent_id = doc["parent_map"].get(src_id)
        src_parent_obj = doc["elements"].get(src_parent_id) if src_parent_id is not None else None
        if src_parent_obj is not None:
            _remove_kid(src_parent_obj, src_obj)

    return {"tree": _rebuild_after_mutation(doc_id), **_undo_state(doc)}


# --- content-leaf text splitting ------------------------------------------
#
# Backs the Tag Properties panel's "Split Content" action: given a content
# leaf whose drawn text is e.g. "1.) Blah", split it into two leaves - one
# carrying "1.)", the other "Blah" - so they can be tagged separately (a Lbl
# and an LBody, most commonly). Unlike everything else content-leaf-related
# in this file (reorder, delete, wrap - see the module docstring), this is
# real content-stream surgery: the leaf's text isn't an attribute anywhere,
# it's baked into `Tj`/`TJ`/`'`/`"` operators inside the leaf's own
# `BDC ... EMC` span, so "splitting the leaf" means finding the exact byte
# offset inside those operators and dividing them in two.
#
# The one rule this whole section is built around: never guess. A font's
# text is only as splittable as it is *provably* decodable. Two separate
# questions have to both be answered with certainty before a single font
# code can be sliced out of a string operand:
#   - how many bytes is one code? (_font_code_width) - always 1 for a simple
#     font; for a Type0/CID font, 2 for the near-ubiquitous /Identity-H (or
#     -V) predefined encoding, or read from an embedded /Encoding CMap's own
#     codespace range. This deliberately does *not* come from the font's
#     /ToUnicode CMap's own codespacerange, even though that's also present
#     there - real-world ToUnicode streams commonly declare a *wider*
#     codespace than any code they actually map (e.g. a spec-compliant
#     `<00> <FF>` / `<0100> <FFFF>` pair sitting alongside bfchar entries
#     that are all 2-byte) since it exists to be looked up by, not to
#     describe, the font's real encoding.
#   - what Unicode text does a code of that width decode to?
#     (_parse_bf_mappings, reading the font's /ToUnicode bfchar/bfrange)
# An unrecognized font subtype, an unsupported predefined CMap, a mixed-width
# embedded CMap, an undecodable code, marked content nested inside the span,
# or a split point that doesn't land exactly on a character boundary all
# refuse with a specific reason rather than produce a plausible-looking
# wrong split. A wrong reorder is a tree the user can drag back; a wrong
# content-stream split can corrupt what a viewer actually paints, which is
# why this code takes the conservative branch every time it's unsure.
#
# get_leaf_text() (read-only) and split_leaf() (mutating) share the same
# decode pipeline (_decode_leaf) so what the Tag Properties panel shows the
# user to place a cursor in is *exactly* what split_leaf() will operate on -
# not pdf.js's own text extraction (which the tag tree's preview elsewhere
# uses), since any drift between "what you see" and "what gets split" would
# make the cursor position lie.

def _codespace_widths(text):
    """The distinct byte-widths declared by every `begincodespacerange`
    block in a CMap's own text - {len(lo_hex) // 2 for each <lo> <hi> pair}.
    Shared by _font_code_width() (reading a font's *own* /Encoding CMap,
    when it's an embedded stream rather than a predefined name) - not used
    against a /ToUnicode CMap's codespace, which can legitimately be wider
    than any code it actually maps (see the section docstring above)."""
    widths = set()
    for block in re.findall(r"begincodespacerange(.*?)endcodespacerange", text, re.S):
        for lo, _hi in re.findall(r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", block):
            widths.add(len(lo) // 2)
    return widths


def _font_code_width(font):
    """How many bytes one font code occupies in a `Tj`/`TJ`/`'`/`"` string
    operand for `font` - the width _decode_leaf_content() needs to chop a
    raw operand into codes, before any /ToUnicode lookup happens at all.
    Always 1 for a simple font. For a Type0 (composite) font, 2 for the
    near-ubiquitous predefined /Identity-H or /Identity-V encoding, or
    whatever a single-width embedded /Encoding CMap's own codespace range
    declares - any other predefined CMap name, or a mixed-width embedded
    one, isn't supported (raises ValueError; see the section docstring)."""
    subtype = str(font.get("/Subtype", ""))
    if subtype != "/Type0":
        return 1
    encoding = font.get("/Encoding")
    if isinstance(encoding, pikepdf.Name):
        if str(encoding) in ("/Identity-H", "/Identity-V"):
            return 2
        raise ValueError(f"Unsupported predefined CMap encoding: {encoding}")
    if isinstance(encoding, (pikepdf.Dictionary, pikepdf.Stream)):
        try:
            text = bytes(encoding.read_bytes()).decode("latin-1")
        except Exception as exc:
            raise ValueError(f"Could not read this font's Encoding CMap: {exc}") from exc
        widths = _codespace_widths(text)
        if len(widths) != 1:
            raise ValueError("This font's Encoding CMap has no single, unambiguous character width")
        return widths.pop()
    raise ValueError("This font's character encoding isn't recognized")


def _parse_bf_mappings(stream_bytes):
    """Parses a /ToUnicode CMap stream's `beginbfchar`/`beginbfrange` blocks
    into {code_int: decoded_str}. This is a light regex-based reader for the
    predictable shape font-embedding tools actually emit, not a full
    PostScript interpreter - anything it doesn't recognize (a malformed
    range, ...) raises ValueError rather than silently mis-parsing, since a
    wrong decode here would silently mis-split real text."""
    try:
        text = stream_bytes.decode("latin-1")
    except Exception as exc:
        raise ValueError(f"Could not read this font's ToUnicode CMap: {exc}") from exc

    def dst_to_text(hex_str):
        raw = bytes.fromhex(hex_str)
        if len(raw) % 2 != 0:
            raise ValueError("Malformed ToUnicode destination string")
        return raw.decode("utf-16-be")

    mapping = {}
    for block in re.findall(r"beginbfchar(.*?)endbfchar", text, re.S):
        for code_hex, dst_hex in re.findall(r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", block):
            mapping[int(code_hex, 16)] = dst_to_text(dst_hex)

    for block in re.findall(r"beginbfrange(.*?)endbfrange", text, re.S):
        # Array form: <lo> <hi> [ <d0> <d1> ... ] - one explicit destination
        # per code in the range.
        for lo_hex, hi_hex, array_body in re.findall(
            r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[(.*?)\]", block, re.S
        ):
            lo, hi = int(lo_hex, 16), int(hi_hex, 16)
            dsts = re.findall(r"<([0-9A-Fa-f]+)>", array_body)
            if len(dsts) != hi - lo + 1:
                raise ValueError("Malformed ToUnicode bfrange array")
            for code, dst_hex in zip(range(lo, hi + 1), dsts):
                mapping[code] = dst_to_text(dst_hex)
        # Scalar form: <lo> <hi> <dst> - dst increments by (code - lo) for
        # each code in the range. Matched against whatever the array form
        # above didn't already consume, so the two forms can't double-count
        # the same range.
        remainder = re.sub(r"<[0-9A-Fa-f]+>\s*<[0-9A-Fa-f]+>\s*\[.*?\]", "", block, flags=re.S)
        for lo_hex, hi_hex, dst_hex in re.findall(
            r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", remainder
        ):
            lo, hi = int(lo_hex, 16), int(hi_hex, 16)
            dst_bytes = bytes.fromhex(dst_hex)
            base = int.from_bytes(dst_bytes, "big")
            for offset, code in enumerate(range(lo, hi + 1)):
                value = base + offset
                mapping[code] = value.to_bytes(len(dst_bytes), "big").decode("utf-16-be")

    return mapping


def _font_tounicode(page, font_name):
    """(width, mapping) - width from _font_code_width(), mapping from
    _parse_bf_mappings() - for /Resources/Font/<font_name> on `page`, or
    None if the font can't be resolved, its encoding isn't one this file
    understands, or it carries no /ToUnicode. /Resources is inheritable the
    same way /MediaBox is (see _resolve_inherited) - a font used by every
    page in a section is often set once on a shared /Pages node rather than
    repeated per page."""
    resources = _resolve_inherited(page.obj, "/Resources")
    fonts = resources.get("/Font") if isinstance(resources, pikepdf.Dictionary) else None
    font = fonts.get(font_name) if isinstance(fonts, pikepdf.Dictionary) else None
    if not isinstance(font, pikepdf.Dictionary) or "/ToUnicode" not in font:
        return None
    try:
        width = _font_code_width(font)
        mapping = _parse_bf_mappings(bytes(font["/ToUnicode"].read_bytes()))
    except Exception:
        return None
    return width, mapping


def _find_mcid_block(instructions, mcid):
    """(start, end) indices into `instructions` such that instructions[start]
    is the top-level `<role> BDC <</MCID mcid>>` operator and instructions[end]
    is its matching EMC, tracking BDC/BMC...EMC nesting depth so the match is
    exact even if (unusually, for a plain text leaf) something is nested
    inside it. None if no top-level BDC names this mcid, or its span never
    closes (a malformed content stream) - either way, nothing to split."""
    for i, instr in enumerate(instructions):
        if str(instr.operator) != "BDC" or len(instr.operands) != 2:
            continue
        props = instr.operands[1]
        if not isinstance(props, pikepdf.Dictionary) or "/MCID" not in props:
            continue
        try:
            if int(props["/MCID"]) != mcid:
                continue
        except (TypeError, ValueError):
            continue
        depth = 1
        for j in range(i + 1, len(instructions)):
            op = str(instructions[j].operator)
            if op in ("BDC", "BMC"):
                depth += 1
            elif op == "EMC":
                depth -= 1
                if depth == 0:
                    return i, j
        return None
    return None


def _active_font_before(instructions, index):
    """The font resource name (e.g. "/F1") set by the most recent `Tf`
    strictly before `instructions[index]`, or None if there isn't one - the
    font a marked-content span's own text inherits when the span itself
    contains no Tf of its own."""
    for j in range(index - 1, -1, -1):
        if str(instructions[j].operator) == "Tf" and len(instructions[j].operands) == 2:
            return str(instructions[j].operands[0])
    return None


def _decode_leaf_content(page, instructions, block_start, block_end, font_before):
    """Decodes every text-showing operator strictly inside (block_start,
    block_end) - i.e. between a marked-content span's BDC and its EMC - into
    an ordered list of {"text", "instr" (absolute index into `instructions`),
    "operand_index", "byte_offset"} entries, one per font code. `text` is
    that code's decoded Unicode text per its active font's /ToUnicode (see
    _font_tounicode) - almost always one character, but a ligature code can
    decode to more than one. Raises ValueError, never guesses, the moment
    anything can't be decoded with full confidence (see the section docstring
    above) - ["instr"]/["operand_index"]/["byte_offset"] together are exactly
    enough for _split_block() to slice the original operators back apart at
    any code boundary this returns."""
    current_font = font_before
    font_cache = {}
    codes = []

    def font_info(name):
        if name not in font_cache:
            font_cache[name] = _font_tounicode(page, name) if name else None
        return font_cache[name]

    def decode_operand(instr_idx, operand_index, pikepdf_string, width, mapping):
        raw = bytes(pikepdf_string)
        if len(raw) % width != 0:
            raise ValueError("This text's bytes don't align to its font's character width")
        for offset in range(0, len(raw), width):
            code = int.from_bytes(raw[offset:offset + width], "big")
            if code not in mapping:
                raise ValueError("This text has a character with no Unicode mapping")
            codes.append({
                "text": mapping[code], "instr": instr_idx,
                "operand_index": operand_index, "byte_offset": offset,
            })

    for idx in range(block_start + 1, block_end):
        instr = instructions[idx]
        op = str(instr.operator)
        if op == "Tf" and len(instr.operands) == 2:
            current_font = str(instr.operands[0])
            continue
        if op not in ("Tj", "'", '"', "TJ"):
            continue
        if not current_font:
            raise ValueError("This text has no font set - can't determine character boundaries")
        info = font_info(current_font)
        if info is None:
            raise ValueError("This text's font has no embedded Unicode mapping (ToUnicode) - can't safely split it")
        width, mapping = info

        if op in ("Tj", "'"):
            if not instr.operands or not isinstance(instr.operands[-1], pikepdf.String):
                raise ValueError("Unrecognized text-showing operator")
            decode_operand(idx, len(instr.operands) - 1, instr.operands[-1], width, mapping)
        elif op == '"':
            if len(instr.operands) != 3 or not isinstance(instr.operands[2], pikepdf.String):
                raise ValueError("Unrecognized text-showing operator")
            decode_operand(idx, 2, instr.operands[2], width, mapping)
        elif op == "TJ":
            if len(instr.operands) != 1 or not isinstance(instr.operands[0], pikepdf.Array):
                raise ValueError("Unrecognized text-showing operator")
            for element_index, element in enumerate(instr.operands[0]):
                if isinstance(element, pikepdf.String):
                    decode_operand(idx, element_index, element, width, mapping)

    return codes


def _leaf_page_and_mcid(doc, node_id):
    """(page_index, mcid) for a text-bearing content leaf, or raises
    ValueError - an /OBJR (annotation reference) or a leaf with no readable
    MCID has no content-stream text to decode in the first place."""
    kind = doc["node_kind"].get(node_id)
    if kind not in ("content-int", "content-dict"):
        raise ValueError("Only a content leaf's text can be split")
    page_index = doc["node_pages"].get(node_id)
    if page_index is None:
        raise ValueError("This content leaf's page could not be resolved")
    obj = doc["elements"][node_id]
    if kind == "content-int":
        mcid = int(obj)
    else:
        if not isinstance(obj, pikepdf.Dictionary) or "/MCID" not in obj:
            raise ValueError("This is an object reference, not text - nothing to split")
        try:
            mcid = int(obj["/MCID"])
        except (TypeError, ValueError):
            raise ValueError("This content leaf has no readable marked-content id")
    return page_index, mcid


def _decode_leaf(doc, node_id, *, for_write=False):
    """Full read pipeline shared by get_leaf_text() and split_leaf(): locate
    `node_id`'s marked-content span on its page and decode every
    text-showing operator inside it. Returns (page, page_index, block_start,
    block_end, instructions, codes) on success. Raises ValueError - with a
    message safe to show the user as-is - the instant anything can't be
    decoded with full confidence; see the section docstring above.

    `for_write` coalesces an array-valued /Pg /Contents down to the single
    stream split_leaf() needs to write its rewritten operators back into.
    That is a document mutation, so it stays off by default: get_leaf_text()
    runs on every content-leaf *selection*, and coalescing there rewrote the
    page's content structure behind the user's back - outside any undo
    snapshot, without marking the document dirty, and (since it happened
    before split_leaf()'s own _push_undo_snapshot) with no way to undo back
    to the original array form. Reading needs no coalesce of its own:
    parse_content_stream() already treats a page's array /Contents as one
    coalesced stream, without touching the document."""
    page_index, mcid = _leaf_page_and_mcid(doc, node_id)
    page = doc["pdf"].pages[page_index]
    if for_write:
        page.contents_coalesce()
    try:
        instructions = pikepdf.parse_content_stream(page)
    except Exception as exc:
        raise ValueError(f"Could not read this page's content stream: {exc}") from exc

    found = _find_mcid_block(instructions, mcid)
    if found is None:
        raise ValueError(
            "Could not find this content leaf's marked content on the page "
            "(or it contains nested marked content, which isn't supported)"
        )
    block_start, block_end = found

    codes = _decode_leaf_content(
        page, instructions, block_start, block_end,
        font_before=_active_font_before(instructions, block_start),
    )
    if not codes:
        raise ValueError("This content leaf has no text to split")

    return page, page_index, block_start, block_end, instructions, codes


def get_leaf_text(doc_id, node_id):
    """Read-only: the exact text split_leaf() would operate on for this
    content leaf. `text` is null with a human-readable `reason` when this
    leaf can't be safely decoded (no /ToUnicode, nested marked content, an
    object reference, ...) - the Tag Properties panel shows that in place of
    the split field rather than letting the user try to split something that
    isn't provably splittable."""
    doc = documents[doc_id]
    try:
        _page, _page_index, _start, _end, _instructions, codes = _decode_leaf(doc, node_id)
    except ValueError as exc:
        return {"text": None, "reason": str(exc)}
    return {"text": "".join(c["text"] for c in codes)}


def _split_instruction(instr, cut_operand_index, cut_byte_offset):
    """Splits one text-showing ContentStreamInstruction into (before, after)
    at `cut_byte_offset` within its operand at `cut_operand_index` - either
    half is None when the cut falls exactly at that half's edge (e.g.
    splitting right before a TJ array's first element leaves nothing for
    "before"). Only ever called with a cut that _decode_leaf_content already
    proved lands cleanly on a font-code boundary."""
    op = str(instr.operator)
    if op in ("Tj", "'"):
        raw = bytes(instr.operands[-1])
        before, after = raw[:cut_byte_offset], raw[cut_byte_offset:]
        fixed = list(instr.operands[:-1])
        before_instr = pikepdf.ContentStreamInstruction(fixed + [pikepdf.String(before)], instr.operator) if before else None
        after_instr = pikepdf.ContentStreamInstruction(fixed + [pikepdf.String(after)], instr.operator) if after else None
        return before_instr, after_instr
    if op == '"':
        raw = bytes(instr.operands[2])
        before, after = raw[:cut_byte_offset], raw[cut_byte_offset:]
        aw, ac = instr.operands[0], instr.operands[1]
        before_instr = pikepdf.ContentStreamInstruction([aw, ac, pikepdf.String(before)], instr.operator) if before else None
        after_instr = pikepdf.ContentStreamInstruction([aw, ac, pikepdf.String(after)], instr.operator) if after else None
        return before_instr, after_instr
    if op == "TJ":
        array = list(instr.operands[0])
        before_items = list(array[:cut_operand_index])
        after_items = list(array[cut_operand_index + 1:])
        raw = bytes(array[cut_operand_index])
        before_bytes, after_bytes = raw[:cut_byte_offset], raw[cut_byte_offset:]
        if before_bytes:
            before_items.append(pikepdf.String(before_bytes))
        if after_bytes:
            after_items.insert(0, pikepdf.String(after_bytes))
        before_instr = pikepdf.ContentStreamInstruction([pikepdf.Array(before_items)], instr.operator) if before_items else None
        after_instr = pikepdf.ContentStreamInstruction([pikepdf.Array(after_items)], instr.operator) if after_items else None
        return before_instr, after_instr
    raise ValueError("Unsupported text-showing operator")


def _split_block(instructions, block_start, block_end, split_code_index, codes):
    """Everything strictly between a marked-content span's BDC (block_start)
    and EMC (block_end), divided into (instructions_a, instructions_b) at the
    point named by `split_code_index` - codes[:split_code_index] ends up
    drawn by instructions_a, codes[split_code_index:] by instructions_b.
    Anything that carries no text (Tf, positioning, color, ...) simply rides
    along with whichever side it already falls on in document order - moving
    it across a new BDC/EMC pair has no effect on what it does, since marked
    content is transparent to every other operator (see the section
    docstring's note on this)."""
    before_code = codes[split_code_index - 1]
    after_code = codes[split_code_index]
    split_instr_idx = after_code["instr"]

    instructions_a = list(instructions[block_start + 1:split_instr_idx])
    instructions_b = list(instructions[split_instr_idx:block_end])

    if before_code["instr"] == split_instr_idx:
        # The cut falls inside the same instruction both codes belong to -
        # either mid-string (same operand_index) or, for a TJ array, exactly
        # at the boundary between two of its elements (byte_offset 0 of the
        # next element, nothing to slice).
        cut_byte_offset = after_code["byte_offset"] if before_code["operand_index"] == after_code["operand_index"] else 0
        before_instr, after_instr = _split_instruction(
            instructions[split_instr_idx], after_code["operand_index"], cut_byte_offset,
        )
        instructions_b = instructions_b[1:]  # drop the whole, un-split original
        if before_instr is not None:
            instructions_a.append(before_instr)
        if after_instr is not None:
            instructions_b.insert(0, after_instr)
    # else: a clean break between two whole instructions - before_code's
    # instruction is already the tail of instructions_a (it's whatever index
    # < split_instr_idx it was) and split_instr_idx's instruction is already
    # the head of instructions_b, both via the slices above.

    return instructions_a, instructions_b


def _next_mcid_on_page(doc, page_index):
    """One past the highest MCID currently in use on `page_index` - by its
    content stream (the source of truth) or, for safety, by whatever the
    struct tree itself already claims there (see _content_owners) in case
    the two have drifted apart (e.g. repair_orphaned_marked_content hasn't
    run yet) - so a freshly split leaf never mints an id that collides with
    either."""
    page = doc["pdf"].pages[page_index]
    highest = -1
    try:
        for instr in pikepdf.parse_content_stream(page):
            if str(instr.operator) == "BDC" and len(instr.operands) == 2:
                props = instr.operands[1]
                if isinstance(props, pikepdf.Dictionary) and "/MCID" in props:
                    try:
                        highest = max(highest, int(props["/MCID"]))
                    except (TypeError, ValueError):
                        pass
    except Exception:
        pass
    per_page, _ = _content_owners(doc)
    for mcid in per_page.get(page_index, {}):
        highest = max(highest, mcid)
    return highest + 1


def _leaf_id_for_mcid(doc, page_index, mcid):
    """The just-rebuilt registry's node id for the content leaf on
    `page_index` carrying `mcid`, or None - used right after
    _rebuild_after_mutation() to translate split_leaf()'s two new MCIDs back
    into the fresh node ids the renderer needs to select them."""
    for node_id, kind in doc["node_kind"].items():
        if kind not in ("content-int", "content-dict"):
            continue
        if doc["node_pages"].get(node_id) != page_index:
            continue
        obj = doc["elements"][node_id]
        if kind == "content-int":
            if int(obj) == mcid:
                return node_id
        elif isinstance(obj, pikepdf.Dictionary) and "/MCID" in obj:
            try:
                if int(obj["/MCID"]) == mcid:
                    return node_id
            except (TypeError, ValueError):
                continue
    return None


def split_leaf(doc_id, node_id, split_index):
    """Splits one content leaf's marked content into two at character offset
    `split_index` into get_leaf_text()'s decoded text (so `split_index` must
    land exactly between two font codes - not inside one, e.g. a ligature -
    with real text on both sides). Backs the Tag Properties panel's "Split
    Content" action. The new leaf lands as `node_id`'s immediate next
    sibling, carrying a freshly minted MCID (see _next_mcid_on_page);
    `node_id` itself keeps its original MCID and, for a bare-MCID leaf, its
    node id too - only a /MCR leaf needs a new dict, since the original
    keeps every key (/Pg included) except /MCID.

    Unlike every other mutating command here, the result also carries a
    fresh `pdfBase64` snapshot of the whole (still unsaved) document: this
    is the one command that rewrites a page's *content stream*, and the
    renderer's PDF preview is pdf.js's own separate parse of that same
    stream, taken once at open and otherwise never re-fed new bytes (a
    struct-tree-only edit never needs to be, since content streams don't
    change). Without handing back fresh bytes here, the preview's page text
    and highlight boxes would keep reading the pre-split content stream -
    right MCIDs in the tree, stale text/positions on the page - until the
    next full close/reopen."""
    doc = documents[doc_id]
    if node_id not in doc["elements"]:
        raise ValueError(f"Unknown node id: {node_id}")

    page, page_index, block_start, block_end, instructions, codes = _decode_leaf(doc, node_id, for_write=True)

    boundaries = [0]
    for c in codes:
        boundaries.append(boundaries[-1] + len(c["text"]))
    try:
        split_code_index = boundaries.index(split_index)
    except ValueError:
        split_code_index = -1
    if split_code_index <= 0 or split_code_index >= len(codes):
        raise ValueError("Place the cursor strictly between two characters, with text on both sides, to split there")

    parent_id = doc["parent_map"].get(node_id)
    if parent_id is None:
        raise ValueError("This content leaf has no parent to split it within")
    parent_obj = doc["elements"][parent_id]
    node_obj = doc["elements"][node_id]
    index_in_parent = _kid_index(parent_obj, node_obj)
    if index_in_parent == -1:
        raise ValueError("Could not locate this content leaf in its parent")

    instructions_a, instructions_b = _split_block(instructions, block_start, block_end, split_code_index, codes)

    orig_bdc = instructions[block_start]
    tag_operand = orig_bdc.operands[0]
    props_a = orig_bdc.operands[1]
    original_mcid = int(props_a["/MCID"])
    new_mcid = _next_mcid_on_page(doc, page_index)
    props_b = pikepdf.Dictionary({k: v for k, v in props_a.items()})
    props_b["/MCID"] = new_mcid

    emc = pikepdf.ContentStreamInstruction([], pikepdf.Operator("EMC"))
    bdc_b = pikepdf.ContentStreamInstruction([tag_operand, props_b], pikepdf.Operator("BDC"))
    new_sequence = [orig_bdc, *instructions_a, emc, bdc_b, *instructions_b, emc]
    final_instructions = instructions[:block_start] + new_sequence + instructions[block_end + 1:]

    _push_undo_snapshot(doc)

    page.obj.Contents.write(pikepdf.unparse_content_stream(final_instructions))

    kind = doc["node_kind"].get(node_id)
    leaf_a = node_obj
    if kind == "content-int":
        leaf_b = new_mcid
    else:
        leaf_b = pikepdf.Dictionary({k: v for k, v in node_obj.items()})
        leaf_b["/MCID"] = new_mcid

    _remove_kid(parent_obj, node_obj)
    _insert_kid(parent_obj, leaf_a, index_in_parent)
    _insert_kid(parent_obj, leaf_b, index_in_parent + 1)

    tree = _rebuild_after_mutation(doc_id)
    new_id_a = _leaf_id_for_mcid(doc, page_index, original_mcid)
    new_id_b = _leaf_id_for_mcid(doc, page_index, new_mcid)
    pdf_base64 = base64.b64encode(_snapshot_bytes(doc["pdf"])).decode("ascii")

    return {
        "tree": tree, "newNodeIds": [new_id_a, new_id_b], "pdfBase64": pdf_base64,
        **_undo_state(doc),
    }


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
        # Just link the object; _rebuild_parent_tree() (via
        # _rebuild_after_mutation below) allocates the image's
        # /StructParent and writes the matching /ParentTree entry, the same
        # way it does for every other tagged object. That's also what
        # retired this branch's old refusal of documents whose /ParentTree
        # came as a multi-level /Kids tree - the rebuild emits a flat /Nums
        # regardless of what the input used.
        figure["/K"] = pikepdf.Dictionary({
            "/Type": pikepdf.Name("/OBJR"),
            "/Pg": page.obj,
            "/Obj": best["xobject"],
        })
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

    tree = _rebuild_after_mutation(doc_id)
    new_node_id = next((nid for nid, obj in doc["elements"].items() if _same_object(obj, figure)), None)

    return {"tree": tree, "newNodeId": new_node_id, "method": method, **_undo_state(doc)}


def insert_paragraph_after(doc_id, node_id):
    """Inserts a new, empty /P struct element as the next sibling right
    after `node_id` - backs the tag tree's Ctrl/Cmd+P shortcut and "Add P"
    button. Unlike the bare 'P' shortcut (convert_to_paragraph()), which
    relabels/wraps the existing selection in place, this always creates a
    brand-new tag alongside it. With no selection, or the document root
    selected, there's no sibling slot to anchor to, so it falls back to
    appending under the document's insertion parent - the same place
    figure_from_rect() attaches a new top-level tag. Like every other freshly
    created tag in this file, it starts empty and is filled in afterward
    through the normal update_node path."""
    doc = documents[doc_id]
    if "/StructTreeRoot" not in doc["pdf"].Root:
        raise ValueError("This document has no structure tree yet")

    if node_id and node_id != "root" and node_id in doc["elements"]:
        parent_id = doc["parent_map"][node_id]
        parent_obj = doc["elements"][parent_id]
        node_obj = doc["elements"][node_id]
        index = _kid_index(parent_obj, node_obj)
        if index == -1:
            raise ValueError("Could not locate selected tag in its parent")
        index += 1
        page_index = doc["node_pages"].get(node_id)
    else:
        parent_obj, _ = _document_insertion_parent(doc)
        index = len(_iter_kids(parent_obj))
        page_index = None

    new_p = doc["pdf"].make_indirect(pikepdf.Dictionary({
        "/Type": pikepdf.Name("/StructElem"),
        "/S": pikepdf.Name("/P"),
        "/P": parent_obj,
    }))
    if page_index is not None:
        new_p["/Pg"] = doc["pdf"].pages[page_index].obj

    _push_undo_snapshot(doc)
    _insert_kid(parent_obj, new_p, index)

    tree = _rebuild_after_mutation(doc_id)
    new_node_id = _node_id_for_object(doc, new_p)

    return {"tree": tree, "newNodeId": new_node_id, **_undo_state(doc)}


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


def close_document(doc_id):
    """Drops a document and everything hanging off it. Nothing else here
    ever removes an entry from `documents`, and the worker outlives every
    document the user opens - so without this, each Open leaks a live
    pikepdf.Pdf plus its undo/redo snapshots (MAX_UNDO_DEPTH full
    serializations of the file, which for a scanned PDF is hundreds of
    megabytes) for the rest of the session. The host calls this from
    performOpen() once a replacement document has been opened
    successfully - see renderer.js.

    Deliberately tolerant of an unknown/already-closed id: this is cleanup,
    and a host that retries or races a close has nothing useful to do with
    an exception."""
    doc = documents.pop(doc_id, None)
    if doc is None:
        return {"closed": False}
    doc["undo_stack"].clear()
    doc["redo_stack"].clear()
    doc["elements"].clear()
    doc["parent_map"].clear()
    doc["children_map"].clear()
    try:
        doc["pdf"].close()
    except Exception:
        pass
    return {"closed": True}


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
            elif cmd == "update_actual_texts":
                result = update_actual_texts(request["docId"], request["updates"])
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
            elif cmd == "flatten_tags":
                result = flatten_tags(request["docId"], request["nodeIds"])
            elif cmd == "scope_tables":
                result = scope_tables(request["docId"])
            elif cmd == "delete_nodes":
                result = delete_nodes(request["docId"], request["nodeIds"])
            elif cmd == "repair_orphaned_artifacts":
                result = repair_orphaned_marked_content(request["docId"])
            elif cmd == "join_tags":
                result = join_tags(request["docId"], request["nodeIds"])
            elif cmd == "get_leaf_text":
                result = get_leaf_text(request["docId"], request["nodeId"])
            elif cmd == "split_leaf":
                result = split_leaf(request["docId"], request["nodeId"], request["splitIndex"])
            elif cmd == "figure_from_rect":
                result = figure_from_rect(request["docId"], request["pageIndex"], request["rect"])
            elif cmd == "insert_paragraph_after":
                result = insert_paragraph_after(request["docId"], request.get("nodeId"))
            elif cmd == "set_role_or_wrap":
                result = set_role_or_wrap(request["docId"], request["nodeIds"], request["role"])
            elif cmd == "convert_to_paragraph":
                result = convert_to_paragraph(request["docId"], request["nodeIds"])
            elif cmd == "convert_to_figure":
                result = convert_to_figure(request["docId"], request["nodeIds"])
            elif cmd == "make_list":
                result = make_list(request["docId"], request["nodeIds"], request.get("labelFlags", {}))
            elif cmd == "convert_to_list_item":
                result = convert_to_list_item(request["docId"], request["nodeIds"], request.get("labelFlags", {}))
            elif cmd == "make_table":
                result = make_table(request["docId"], request["nodeIds"])
            elif cmd == "make_tr":
                result = make_tr(request["docId"], request["nodeIds"])
            elif cmd == "undo":
                result = undo_edit(request["docId"])
            elif cmd == "redo":
                result = redo_edit(request["docId"])
            elif cmd == "add_bookmark":
                result = add_bookmark(request["docId"], request["page"], request["title"])
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
            elif cmd == "close":
                result = close_document(request["docId"])
            else:
                raise ValueError(f"Unknown command: {cmd}")
            _send({"id": req_id, "result": result})
        except Exception as exc:  # noqa: BLE001 - report to host, never crash the loop
            _send({"id": req_id, "error": f"{type(exc).__name__}: {exc}"})


if __name__ == "__main__":
    main()
