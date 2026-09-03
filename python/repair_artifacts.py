"""
repair_artifacts.py

Command-line equivalent of the app's "Repair Orphaned Content" toolbar
button/script step - see repair_orphaned_marked_content() in tag_worker.py
for the full mechanism. It fixes three kinds of marked content PDF/UA
requires be either tagged or a real /Artifact, and that Acrobat's
accessibility Full Check reads directly from the content stream and fails
even though nothing in this editor's Tags panel shows a problem:

  - Leftovers from the Smartifact/Delete content-stream bug: older versions
    of delete_nodes() (which backs both the tag tree's Delete key and the
    Smartifact tool) unlinked a leaf from the struct tree without also
    rewriting its content-stream BDC operator, leaving marked content that
    still names a real struct role (typically /Figure, for a "smartified"
    full-page scan) with an MCID no structure element claims any more.
  - Content the struct tree never claimed in the first place: formatting
    "glue" spans some authoring tools emit outside every tag (hyphenation/
    kerning hints, invisible joiners around wrapped URLs/DOIs), which carry
    no MCID at all and so could never have been linked to the struct tree.
  - Content painted with no marked-content wrapper at all - not even a
    tagless one - such as a decorative background band drawn via an
    unwrapped XObject invocation, or a lone invisible spacing character.

This is useful for files edited by this app before the fix landed, or as a
one-off, scriptable way to clean up a file without opening it in the app;
the in-app button covers the same ground going forward.

Usage:
    python repair_artifacts.py FILE.pdf [FILE2.pdf ...]
    python repair_artifacts.py --in-place FILE.pdf [FILE2.pdf ...]
    python repair_artifacts.py -o OUTPUT.pdf FILE.pdf

Without -o/--in-place, each FILE.pdf is repaired to FILE.repaired.pdf
alongside it, leaving the original untouched. -o only accepts a single
input file. --in-place overwrites each input directly - there's no undo
once this runs outside the app, so make sure you have a backup (or are
working from version control) first.
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import tag_worker as tw  # noqa: E402 - needs sys.path set up first


def repair_file(path, out_path):
    result = tw.open_document(str(path))
    doc_id = result["docId"]
    try:
        if not result["hasStructTree"]:
            print(f"  skipped: no structure tree")
            return
        repair_result = tw.repair_orphaned_marked_content(doc_id)
        count = repair_result["repairedCount"]
        if count == 0:
            print(f"  clean: no orphaned tagged content found")
            return
        tw.save_document(doc_id, str(out_path))
        print(f"  repaired {count} orphaned tag{'' if count == 1 else 's'} -> {out_path}")
    finally:
        tw.close_document(doc_id)


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("files", nargs="+", type=Path, help="PDF file(s) to repair")
    parser.add_argument("-o", "--output", type=Path, help="Output path (single input file only)")
    parser.add_argument("--in-place", action="store_true", help="Overwrite each input file directly")
    args = parser.parse_args()

    if args.output and (len(args.files) > 1 or args.in_place):
        parser.error("-o/--output only works with a single input file and without --in-place")

    exit_code = 0
    for path in args.files:
        print(f"{path}:")
        if not path.is_file():
            print(f"  not found")
            exit_code = 1
            continue
        if args.output:
            out_path = args.output
        elif args.in_place:
            out_path = path
        else:
            out_path = path.parent / f"{path.stem}.repaired{path.suffix or '.pdf'}"
        try:
            repair_file(path, out_path)
        except Exception as exc:
            print(f"  error: {type(exc).__name__}: {exc}")
            exit_code = 1

    sys.exit(exit_code)


if __name__ == "__main__":
    main()
