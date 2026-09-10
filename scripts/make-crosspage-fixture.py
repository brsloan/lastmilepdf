"""Builds test-crosspage-spans.pdf - a tagged two-page PDF whose
organizational wrappers are the only thing saying which page the content
under them belongs to.

/Pg is inheritable: a bare MCID has no dictionary of its own, so it is
numbered against whichever ancestor last set /Pg. A Span that carries a /Pg
its parent doesn't share is therefore load-bearing, and dissolving it - which
is exactly what flatten_tags() does - has to put that page back somewhere or
the content under it silently repoints at another page's marked content.
MCIDs restart per page, so "another page's MCID 0" is real content owned by
some other tag, not a blank.

test-complex.pdf has plenty of organizational tags but none that
straddle a page break, so the recovery paths in
_flatten_organizational_tags() would otherwise go untested. This fixture is
built to hit all three of them, and its MCID numbers deliberately collide
across the two pages so a regression shows up as content moving rather than
content vanishing:

  P (/Pg=p1) > Span (/Pg=p2) > bare MCID, and a /Pg-less P
      The parent is already committed to page 1, so the page-2 content has
      to carry its own page: the bare MCID is promoted to an /MCR, and the
      /Pg-less nested P is given an explicit /Pg.

  LBody (no /Pg at all) > Span (/Pg=p2) > bare MCID
      Nothing above the LBody names a page either, so it can simply adopt
      the dissolved Span's - the cheap path, which keeps the MCID bare and
      editable. This is the shape that broke a real list item.

  P (no /Pg) > Div (no /Pg) > Span (/Pg=p2) > bare MCID
      The same adoption, but one level removed: the page only reaches the
      Div by adoption when the Span dissolves, and the P has to pick it up
      from the Div in turn.

    python scripts/make-crosspage-fixture.py
"""

import os

import pikepdf

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "test-crosspage-spans.pdf")

# (mcid, text) per page. The numbering collides on purpose - see above.
PAGE_ONE = [
    (0, "Page one, owned by the paragraph that swallows a page-two Span."),
    (1, "Page one, in a paragraph that nothing is nested inside."),
    (2, "1."),
]
PAGE_TWO = [
    (0, "Page two, in a Span the page-one paragraph wraps."),
    (1, "Page two, in a paragraph with no page of its own."),
    (2, "Page two, the body of a list item whose label is on page one."),
    (3, "Page two, under a Div that wraps a Span."),
]


def escape(text):
    return text.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


def content_for(pdf, runs):
    """One marked-content span per run, each its own BDC/EMC, so every MCID
    names a distinct piece of real text."""
    body = []
    for i, (mcid, text) in enumerate(runs):
        body.append(f"/P <</MCID {mcid}>> BDC")
        body.append("BT")
        body.append("/F1 12 Tf")
        body.append(f"1 0 0 1 72 {720 - i * 20} Tm ({escape(text)}) Tj")
        body.append("ET")
        body.append("EMC")
    return pdf.make_stream("\n".join(body).encode("latin-1"))


def build():
    pdf = pikepdf.Pdf.new()

    font = pdf.make_indirect(pikepdf.Dictionary({
        "/Type": pikepdf.Name("/Font"),
        "/Subtype": pikepdf.Name("/Type1"),
        "/BaseFont": pikepdf.Name("/Helvetica"),
        "/Encoding": pikepdf.Name("/WinAnsiEncoding"),
    }))

    for runs in (PAGE_ONE, PAGE_TWO):
        page = pdf.make_indirect(pikepdf.Dictionary({
            "/Type": pikepdf.Name("/Page"),
            "/MediaBox": pikepdf.Array([0, 0, 612, 792]),
            "/Resources": pikepdf.Dictionary({"/Font": pikepdf.Dictionary({"/F1": font})}),
            "/Contents": content_for(pdf, runs),
        }))
        pdf.pages.append(pikepdf.Page(page))
    p1, p2 = pdf.pages[0].obj, pdf.pages[1].obj

    def elem(role, **entries):
        return pdf.make_indirect(pikepdf.Dictionary({
            "/Type": pikepdf.Name("/StructElem"),
            "/S": pikepdf.Name(f"/{role}"),
            **{f"/{key}": value for key, value in entries.items()},
        }))

    # A page-one paragraph whose second half lives on page two, inside a Span
    # that owns that page - along with a paragraph that inherits it.
    nested_p = elem("P", K=1)
    inner_span = elem("Span", Pg=p2, K=pikepdf.Array([0, nested_p]))
    straddling_p = elem("P", Pg=p1, K=pikepdf.Array([0, inner_span]))

    # A plain page-one paragraph, so the fixture has content that flatten
    # must leave completely alone.
    plain_p = elem("P", Pg=p1, K=1)

    # A list item whose label is on page one and whose body is on page two -
    # and the LBody itself names no page, so the Span inside it is the only
    # thing that does.
    body_span = elem("Span", Pg=p2, K=2)
    label = elem("Lbl", Pg=p1, K=2)
    list_body = elem("LBody", K=pikepdf.Array([body_span]))
    list_item = elem("LI", K=pikepdf.Array([label, list_body]))
    the_list = elem("L", K=pikepdf.Array([list_item]))

    # The same, one level deeper: neither the paragraph nor the Div names a
    # page, so the Div can only learn one by dissolving the Span first.
    buried_span = elem("Span", Pg=p2, K=3)
    wrapping_div = elem("Div", K=pikepdf.Array([buried_span]))
    buried_p = elem("P", K=pikepdf.Array([wrapping_div]))

    struct_root = pdf.make_indirect(pikepdf.Dictionary({
        "/Type": pikepdf.Name("/StructTreeRoot"),
    }))
    document = elem("Document", K=pikepdf.Array([
        straddling_p, plain_p, the_list, buried_p,
    ]))
    document["/P"] = struct_root
    struct_root["/K"] = pikepdf.Array([document])

    for parent, kids in (
        (document, [straddling_p, plain_p, the_list, buried_p]),
        (straddling_p, [inner_span]),
        (inner_span, [nested_p]),
        (the_list, [list_item]),
        (list_item, [label, list_body]),
        (list_body, [body_span]),
        (buried_p, [wrapping_div]),
        (wrapping_div, [buried_span]),
    ):
        for kid in kids:
            kid["/P"] = parent

    # /ParentTree: per page, an array indexed by MCID naming the element that
    # owns it. flatten_tags() rewrites this from the tree afterwards, so it
    # only has to be right for the file as built.
    struct_root["/ParentTree"] = pdf.make_indirect(pikepdf.Dictionary({
        "/Nums": pikepdf.Array([
            0, pikepdf.Array([straddling_p, plain_p, label]),
            1, pikepdf.Array([inner_span, nested_p, body_span, buried_span]),
        ]),
    }))
    struct_root["/ParentTreeNextKey"] = 2
    p1["/StructParents"] = 0
    p2["/StructParents"] = 1

    pdf.Root["/StructTreeRoot"] = struct_root
    pdf.Root["/MarkInfo"] = pikepdf.Dictionary({"/Marked": True})
    pdf.Root["/Lang"] = pikepdf.String("en-US")

    pdf.save(OUT)
    print(f"wrote {os.path.relpath(OUT, ROOT)}")


if __name__ == "__main__":
    build()
