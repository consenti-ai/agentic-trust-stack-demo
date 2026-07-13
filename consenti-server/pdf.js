// Renders the agreement PDF and tracks where the signature/date fields land
// so we can tell Blocksee's REST API exactly where to place them (as
// percentages of page width/height, matching what create_agreement_from_text
// produces).

const PDFDocument = require('pdfkit');

const PAGE_SIZE = 'LETTER'; // 612 x 792 pt

function renderAgreementPdf({ title, recital, clauses, parties }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: PAGE_SIZE, margins: { top: 72, bottom: 72, left: 72, right: 72 } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve({ buffer: Buffer.concat(chunks), fields }));
    doc.on('error', reject);

    const fields = [];
    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const pct = (x, y) => ({ x: (x / pageW) * 100, y: (y / pageH) * 100 });

    // pdfkit has no doc.page.number — track 1-indexed page count ourselves.
    // 'pageAdded' only fires for pages after the first (implicit) one.
    let pageIndex = 1;
    doc.on('pageAdded', () => { pageIndex++; });

    doc.font('Helvetica-Bold').fontSize(18).text(title, { align: 'center' });
    doc.moveDown(1.5);

    doc.font('Helvetica').fontSize(11).text(recital, { align: 'justify' });
    doc.moveDown(1);

    clauses.forEach((clause, i) => {
      doc.font('Helvetica-Bold').fontSize(11).text(`${i + 1}. ${clause.heading}. `, { continued: true });
      doc.font('Helvetica').fontSize(11).text(clause.text, { align: 'justify' });
      doc.moveDown(0.8);
    });

    doc.moveDown(1.5);

    parties.forEach((party, i) => {
      doc.font('Helvetica').fontSize(11).text(`${party.name}`);
      const sigLineY = doc.y;
      doc.text('Signature: ________________________        Date: ______________');
      const { x: sigX, y: sigY } = pct(72, sigLineY);
      const { x: dateX } = pct(72 + 260, sigLineY);
      fields.push({ type: 'signature', label: `${party.name} - Signature`, signer_index: i, x: sigX, y: sigY, page: pageIndex });
      fields.push({ type: 'date-signed', label: `${party.name} - Date`, signer_index: i, x: dateX, y: sigY, page: pageIndex });
      doc.moveDown(1.2);
    });

    doc.end();
  });
}

module.exports = { renderAgreementPdf };
