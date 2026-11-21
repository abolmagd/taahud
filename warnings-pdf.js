"use strict";

window.TaahudWarningsPdf = (function () {
  const margin = 35;
  const rowHeight = 30;
  const columnWidths = [52, 144, 66, 87, 91, 85];
  const font = '"Noto Sans Arabic", Arial, sans-serif';

  function loadJsPdf() {
    if (window.jspdf?.jsPDF) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/jspdf@4.2.1/dist/jspdf.umd.min.js";
      script.integrity = "sha384-qovJwSBbRDPP5cEjCp8S0UP66wrvnjaa60XMOGzTNanrThcrGfXfnZkvgY8N1KT3";
      script.crossOrigin = "anonymous";
      script.onload = resolve;
      script.onerror = () => {
        script.remove();
        reject(new Error("jsPDF could not be loaded"));
      };
      document.head.appendChild(script);
    });
  }

  async function save(headers, rows, asOfDate) {
    await loadJsPdf();
    const pdf = new window.jspdf.jsPDF({ format: "a4", unit: "pt", compress: true });
    const width = pdf.internal.pageSize.getWidth();
    const height = pdf.internal.pageSize.getHeight();
    const tableWidth = columnWidths.reduce((sum, column) => sum + column, 0);
    const tableLeft = width - margin - tableWidth;
    const tableTop = 108;
    const rowsPerPage = Math.floor((height - tableTop - margin - 35) / rowHeight) - 1;
    const totalPages = Math.ceil(rows.length / rowsPerPage);
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(width * 2);
    canvas.height = Math.ceil(height * 2);

    // Canvas keeps Arabic shaping and mixed Arabic/Latin names intact in the PDF.
    await Promise.all([
      document.fonts.load("12px " + font, "إنذارات 0123"),
      document.fonts.load("700 22px " + font, "إنذارات 0123"),
    ]).catch(() => {});

    const ctx = canvas.getContext("2d");
    ctx.scale(2, 2);
    ctx.direction = "rtl";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    function drawRow(values, top, background, color) {
      ctx.fillStyle = background;
      ctx.fillRect(tableLeft, top, tableWidth, rowHeight);
      ctx.fillStyle = color;
      let right = width - margin;
      values.forEach((value, index) => {
        ctx.fillText(String(value), right - 8, top + rowHeight / 2, columnWidths[index] - 16);
        right -= columnWidths[index];
      });
    }

    for (let page = 0; page < totalPages; page += 1) {
      if (page > 0) pdf.addPage();
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width / 2, canvas.height / 2);
      ctx.fillStyle = "#1c1917";
      ctx.font = "700 22px " + font;
      ctx.fillText("تعاهُد · إنذارات عدم التسميع", width - margin, 52);
      ctx.font = "12px " + font;
      ctx.fillStyle = "#6b655a";
      const subtitle = (asOfDate ? "حتى " + asOfDate + " · " : "") + "عدد الطلاب " + rows.length;
      ctx.fillText(subtitle, width - margin, 82);

      drawRow(headers, tableTop, "#eee5d5", "#1c1917");
      const start = page * rowsPerPage;
      rows.slice(start, start + rowsPerPage).forEach((row, index) => {
        drawRow(row, tableTop + (index + 1) * rowHeight, index % 2 ? "#f8f5ed" : "#fff", "#1c1917");
      });
      ctx.fillStyle = "#6b655a";
      ctx.fillText("صفحة " + (page + 1) + " من " + totalPages, width - margin, height - margin);
      pdf.addImage(canvas, "PNG", 0, 0, width, height, undefined, "FAST");
    }
    pdf.save("taahud-warnings" + (asOfDate ? "-" + asOfDate : "") + ".pdf");
  }

  return { save };
})();
