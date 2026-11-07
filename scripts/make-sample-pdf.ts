import { writeFileSync } from "node:fs";
import { PDFDocument, PDFName, PDFString, StandardFonts } from "pdf-lib";

async function main() {
  const doc = await PDFDocument.create();
  doc.setTitle("Port Authority Logistics Ledger — Q3 Confidential");
  doc.setAuthor("Capt. Marcus Vance (Operations Lead)");
  doc.setSubject("Unmanifested Offloading Investigation");
  doc.setKeywords(["customs", "audit", "offloading", "unauthorized"]);
  doc.setCreator("Microsoft Word for macOS 16.78");
  doc.setProducer("Adobe Acrobat Distiller 24.1");
  doc.setCreationDate(new Date("2026-11-04T14:32:00Z"));
  doc.setModificationDate(new Date("2026-11-05T09:15:00Z"));

  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  
  const page = doc.addPage([595, 842]); // A4
  
  page.drawText("PORT AUTHORITY LOGISTICS REPORT", { x: 50, y: 780, size: 18, font });
  page.drawText("CONFIDENTIAL & PRIVILEGED — INTERNAL AUDIT ONLY", { x: 50, y: 755, size: 10, font });
  
  page.drawLine({
    start: { x: 50, y: 740 },
    end: { x: 545, y: 740 },
    thickness: 1,
  });

  page.drawText("Case Reference: CR-2026-11-04-MUM", { x: 50, y: 710, size: 11, font });
  page.drawText("Subject: Irregular customs bypass in Terminal 3 Berth 4", { x: 50, y: 690, size: 11, font });

  const bodyText = [
    "During routine reconciliation between AIS transponder tracking and automated berth",
    "gate logs, three container vessels discharged unmanifested freight between 02:00 and 04:30 UTC.",
    "",
    "No entry declarations or standard phytosanitary inspections were recorded on the central ledger.",
    "Bypassed fees are estimated at USD $1,420,000.",
    "",
    "Evidence attached: Automated weighbridge logs, scanned bill of lading #BL-994821.",
    "This document serves as formal notice to the internal integrity board."
  ];

  let y = 650;
  for (const line of bodyText) {
    if (line.length > 0) {
      page.drawText(line, { x: 50, y, size: 10, font: regular });
    }
    y -= 18;
  }

  const pdfBytes = await doc.save();
  writeFileSync("sample-leak.pdf", pdfBytes);
  console.log(`Generated sample-leak.pdf (${pdfBytes.byteLength} bytes) with embedded author metadata.`);
}

main().catch(console.error);

