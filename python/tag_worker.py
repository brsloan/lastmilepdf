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

    node = {
        "id": node_id,
        "type": "root" if node_id == "root" else "element",
        "role": role,
        "alt": _get_string(struct_obj, "/Alt"),
        "actualText": _get_string(struct_obj, "/ActualText"),
        "lang": _get_string(struct_obj, "/Lang"),
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
            child_id = _next_id(doc)
            doc["elements"][child_id] = kid
            doc["parent_map"][child_id] = node_id
            doc["node_pages"][child_id] = kid_page
            doc["node_kind"][child_id] = "content-dict"
            node["children"].append({
                "id": child_id,
                "type": "object-ref" if kid_type == "/OBJR" else "content",
                "role": None,
                "mcid": mcid_val,
                "page": kid_page,
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
