/**
 * EML builder — the JS port of the bulk-EML flow in manual-sourcing.html.
 *
 * Runs in the content script (needs Blob + download). Templates (subject, To/Cc,
 * HTML body, multilingual Relay boilerplate, RFC822 assembly) are reproduced
 * verbatim from the Flask app so generated emails are byte-for-byte equivalent.
 *
 * There is no pywebview in the extension, so delivery is always the browser
 * Blob download. After generating, it asks the background worker to mark the
 * rows email-generated (the /api/email/mark-generated equivalent).
 *
 * Exposed as `window.__ltlEml` for overlay.js to call.
 */
(function () {
  const TO = "amazonfreight-eu-sourcing@amazon.com";
  const CC = "amazonfreight-eu-sourcing@amazon.com";

  function normalizeUtcDateString(value) {
    const raw = String(value).trim().replace(" ", "T");
    return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`;
  }

  function formatEmailDateTime(isoString, countryCode) {
    if (!isoString) return "";
    const tz = countryCode === "GB" ? "Europe/London" : "Europe/Paris";
    try {
      const utcStr = normalizeUtcDateString(isoString);
      const date = new Date(utcStr);
      if (Number.isNaN(date.getTime())) throw new Error("Invalid date");
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: tz,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hour12: false,
      }).formatToParts(date);
      const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
      return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}`;
    } catch (e) {
      const [d, t] = String(isoString).split("T");
      return `${d} ${(t || "").slice(0, 5)}`;
    }
  }

  function buildHtmlTable(rows) {
    const hasTourId = rows.some((r) => r && r.tour_id);
    const tableRows = rows
      .map(
        (r) => `
    <tr>
      ${hasTourId ? (r.tour_id ? `<td style="background-color:#d4edda;">${r.tour_id || ""}</td>` : `<td></td>`) : ``}
      <td>${r.vrid || ""}</td>
      <td>${r.origin_city || ""} ${r.origin_state || ""}, ${r.orig_address || ""},<br/> ${r.orig_country || ""}, ${r.origin_zip || ""}</td>
      <td>${r.dest_address || ""}, ${r.dest_city || ""} ${r.dest_state || ""},<br/> ${r.dest_country || ""}, ${r.dest_zip || ""}</td>
      <td>${r.orig_node || ""} → ${r.dest_node || ""}</td>
      <td>${r.equipment_type || ""}</td>
      <td>${formatEmailDateTime(r.orig_planned_yard_checkin_time, r.orig_country)}</td>
      <td>${formatEmailDateTime(r.dest_planned_yard_checkin_time, r.dest_country)}</td>
    </tr>
  `
      )
      .join("");

    return `
    <table width="100%" border="1" cellpadding="6" cellspacing="0"
           style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:12px;">
      <thead style="background:#00ABF0;font-weight:bold; color:#ffffff;">
        <tr>
          ${hasTourId ? `<th>Tour ID</th>` : ``}
          <th>VRID</th>
          <th>Origin</th>
          <th>Destination</th>
          <th>Route</th>
          <th>Equipment</th>
          <th>Pickup Time</th>
          <th>Delivery Time</th>
        </tr>
      </thead>
      <tbody>
        ${tableRows}
      </tbody>
    </table>
  `;
  }

  function buildHtmlEmail(rows) {
    const table = buildHtmlTable(rows);
    const today = new Date().toISOString().split("T")[0];

    return `
  <html>
    <body style="font-family:Arial,sans-serif;color:#222;">
      <p>Hello,</p>

      <p>
        We currently have a load request available for the below lanes, therefore, can you please provide your best offer ASAP via EMAIL for our team to review internally.
      </p>

      ${table}

      <p style="margin-top:20px;font-size:11px;">
       Collection/Delivery time and date cannot be amended, please confirm transit time prior to sending offers. Please ensure your carrier SCAC Code is on your tender.<br/>
Please kindly note: if there is no response, please assume this run has been taken or the offer wasn't accepted.<br/>
EN: We have services at a great price on Amazon! Share your best offer in this email or visit Relay to book services. Relay: https://relay.amazon.it/loadboard/search<br/>
ES: Tenemos servicios a buen precio en Amazon! Comparte vuestra mejor oferta en este email o visita Relay para reservar los servicios. Relay: https://relay.amazon.it/loadboard/search<br/>
FR: Nous avons des services à des prix intéressants sur Amazon ! Faites-nous part de votre meilleure offre dans cet e-mail ou visitez Relay pour réserver des services. Relay: https://relay.amazon.it/loadboard/search<br/>
IT: Abbiamo servizi di grande valore su Amazon! Condividete la vostra migliore offerta in questa e-mail o visitate Relay per prenotare i servizi. Relay: https://relay.amazon.it/loadboard/search<br/>
PL: Mamy uslugi w swietnych cenach na Amazon! Podziel sie swoja najlepsza oferta w tym e-mailu lub odwiedz Relay, aby zarezerwowac uslugi. Relay: https://relay.amazon.it/loadboard/search<br/>


      </p>

      <p style="margin-top:20px;">
        Kind Regards,<br/>
        <strong>Amazon Freight EU Sourcing Team</strong>
      </p>

      <hr style="margin-top:30px"/>
      <small style="color:#666;">
        Generated on ${today}
      </small>
    </body>
  </html>
  `;
  }

  /**
   * Build the .eml, trigger a browser download, then mark rows email-generated.
   * @param {object[]} rows selected run rows
   * @param {(vrids:string[]) => Promise<any>} markGenerated callback into background
   */
  async function generateBulkEmailEML(rows, markGenerated, opts = {}) {
    const today = new Date().toISOString().split("T")[0];
    // Per-team recipients/subject tag (Config.TEAMS[x].eml); defaults keep the
    // historical LTL output byte-for-byte.
    const to = opts.to || TO;
    const cc = opts.cc || CC;
    const tag = opts.subjectTag || "[CST][Available Loads]";
    const subject = `${tag} – ${rows.length} load(s) – ${today}`;

    const htmlBody = buildHtmlEmail(rows);

    const emlContent = `From: ${to}
To: ${to}
Cc: ${cc}
Subject: ${subject}
MIME-Version: 1.0
Content-Type: text/html; charset=UTF-8

${htmlBody}`;

    const filename = `Manual_Sourcing_${rows.length}_Loads_${today}.eml`;

    const blob = new Blob([emlContent], { type: "message/rfc822" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);

    if (typeof markGenerated === "function") {
      try {
        await markGenerated(rows.map((r) => r.vrid).filter(Boolean));
      } catch (e) {
        console.error("[eml] markGenerated failed:", e);
      }
    }

    return { filename, count: rows.length };
  }

  window.__ltlEml = { generateBulkEmailEML, buildHtmlEmail, buildHtmlTable, formatEmailDateTime };
})();
