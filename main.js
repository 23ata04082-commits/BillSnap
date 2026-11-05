import "./style.css";
import Tesseract from "tesseract.js";

const app = document.querySelector("#app");

app.innerHTML = `
  <main class="page-shell">
    <header class="hero">
      <div class="brand-mark" aria-hidden="true">🧾</div>
      <div>
        <p class="eyebrow">YOUR SMART EXPENSE TRACKER</p>
        <h1>Bill Snap</h1>
        <p class="hero-copy">Scan your bills, check the details and keep your expenses organised.</p>
      </div>
    </header>

    <section class="card upload-card">
      <div class="section-heading">
        <span class="step-number">01</span>
        <div><h2>Upload your bill</h2><p>Take a photo or choose an image from your device.</p></div>
      </div>
      <label class="upload-zone" for="billImage">
        <span class="upload-icon">＋</span>
        <strong>Choose a bill image</strong>
        <span>JPG, PNG or WEBP · Camera supported on mobile</span>
      </label>
      <input id="billImage" class="visually-hidden" type="file" accept="image/*" capture="environment" />
      <div id="preview" class="preview-area" aria-live="polite"></div>
      <button id="scanBtn" class="primary-button" disabled>Scan bill</button>
      <p id="status" class="status" role="status">Choose an image to get started.</p>
    </section>

    <section class="card review-card">
      <div class="section-heading">
        <span class="step-number">02</span>
        <div><h2>Review bill details</h2><p>Check the extracted information and correct anything that needs attention.</p></div>
      </div>
      <div class="field-grid">
        <div class="field"><label for="merchant">Merchant name</label><input id="merchant" type="text" placeholder="Merchant name" autocomplete="organization" /><small id="merchantHint" class="field-hint">Not scanned yet</small></div>
        <div class="field"><label for="date">Invoice date</label><input id="date" type="date" /><small id="dateHint" class="field-hint">Not scanned yet</small></div>
        <div class="field"><label for="total">Total amount (₹)</label><input id="total" type="number" min="0" step="0.01" placeholder="0.00" /><small id="totalHint" class="field-hint">Not scanned yet</small></div>
        <div class="field"><label for="category">Suggested category</label><select id="category"><option>Food</option><option>Utilities</option><option>Groceries</option></select><small id="categoryHint" class="field-hint">Suggested from bill text</small></div>
      </div>
      <p id="confidence" class="review-note">After scanning, review each field before saving.</p>
      <button id="saveBtn" class="primary-button save-button" disabled>Save bill</button>
      <details class="ocr-details"><summary>View detected text</summary><pre id="ocrText">No text detected yet.</pre></details>
    </section>

    <section class="card recent-card">
      <div class="section-heading">
        <span class="step-number">03</span>
        <div><h2>Recent bills</h2><p>Your saved bills are stored on this device.</p></div>
      </div>
      <div id="billList" class="bill-list"><p class="empty-state">No bills saved yet. Your saved bills will appear here.</p></div>
    </section>
    <footer>Bill Snap · Your bills stay in this browser on this device.</footer>
  </main>
`;

const $ = (id) => document.getElementById(id);
let selectedFile = null;
let worker = null;
let currentScanValid = false;
let lastObjectUrl = null;

const DB_NAME = "BillSnapDatabase";
const STORE_NAME = "bills";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, action) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    let request;
    try { request = action(store); } catch (error) { db.close(); reject(error); return; }
    transaction.oncomplete = () => { db.close(); resolve(request?.result); };
    transaction.onerror = () => { db.close(); reject(transaction.error); };
    transaction.onabort = () => { db.close(); reject(transaction.error || new Error("Database operation aborted")); };
  });
}

const saveToDatabase = (bill) => withStore("readwrite", (store) => store.add(bill));
const getAllBills = async () => {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
    request.onsuccess = () => { db.close(); resolve(request.result || []); };
    request.onerror = () => { db.close(); reject(request.error); };
  });
};
const deleteBill = (id) => withStore("readwrite", (store) => store.delete(id));

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

async function displayBills() {
  try {
    const bills = (await getAllBills()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const list = $("billList");
    if (!bills.length) {
      list.innerHTML = '<p class="empty-state">No bills saved yet. Your saved bills will appear here.</p>';
      return;
    }
    list.innerHTML = bills.map((bill) => `
      <article class="bill-item">
        <div class="bill-main">
          <strong>${escapeHTML(bill.merchant || "Unknown merchant")}</strong>
          <span>${escapeHTML(bill.date || "Date not available")} · ${escapeHTML(bill.category || "Uncategorised")}</span>
        </div>
        <div class="bill-side"><b>₹${Number(bill.total).toFixed(2)}</b><button class="delete-button" data-id="${bill.id}" aria-label="Delete bill">Delete</button></div>
      </article>
    `).join("");
    list.querySelectorAll(".delete-button").forEach((button) => {
      button.addEventListener("click", async () => {
        await deleteBill(Number(button.dataset.id));
        await displayBills();
      });
    });
  } catch (error) {
    console.error(error);
    $("billList").innerHTML = '<p class="empty-state">Could not load saved bills. Please refresh the page.</p>';
  }
}

function setFieldHint(field, message, uncertain = false) {
  const hint = $(`${field}Hint`);
  hint.textContent = message;
  hint.classList.toggle("uncertain", uncertain);
  hint.classList.toggle("confirmed", !uncertain);
}

function parseDateToInput(text) {
  const monthNames = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
    may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
    sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
    dec: 12, december: 12
  };
  const patterns = [
    { regex: /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/, map: (m) => [+m[3], +m[2], +m[1]] },
    { regex: /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/, map: (m) => [+m[1], +m[2], +m[3]] },
    { regex: /\b(\d{1,2})[\s-]+([A-Za-z]{3,9})[\s,-]+(\d{2,4})\b/i, map: (m) => [+m[3], monthNames[m[2].toLowerCase()] || monthNames[m[2].slice(0,3).toLowerCase()], +m[1]] }
  ];
  for (const item of patterns) {
    const match = text.match(item.regex);
    if (!match) continue;
    let [year, month, day] = item.map(match);
    if (!month || month < 1 || month > 12) continue;
    if (year < 100) year += 2000;
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }
  return "";
}

function extractDate(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const labelled = lines.filter((line) => /(invoice\s*date|bill\s*date|date)\s*[:=-]?/i.test(line));
  for (const line of [...labelled, ...lines]) {
    const value = parseDateToInput(line);
    if (value) return value;
  }
  return "";
}

function amountFromMatch(match) {
  if (!match?.[1]) return "";
  const value = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(value) && value > 0 ? value : "";
}

function extractTotal(text) {
  const clean = text.replace(/\r/g, "\n").replace(/[₹]/g, " Rs ");
  const amount = String.raw`(?:Rs\.?|INR)?\s*([\d]{1,3}(?:,[\d]{2,3})*(?:\.\d{1,2})?|[\d]+(?:\.\d{1,2})?)`;

  // Exact "Total <amount>" label, excluding "Total Sale", "Total Tax", etc.
  const exactTotal = new RegExp(String.raw`\btotal\b(?!\s*(?:sale|tax|gst|cess|discount|quantity|items|qty)\b)\s*[:=\-]?\s*${amount}`, "i");
  const exactMatch = clean.match(exactTotal);
  if (exactMatch) {
    const value = amountFromMatch(exactMatch);
    if (value) return value;
  }

  // Other common payable labels.
  const priorityLabels = [
    /grand\s*total/i, /amount\s*payable/i, /net\s*payable/i,
    /balance\s*due/i, /amount\s*due/i, /total\s*amount/i, /bill\s*total/i
  ];
  for (const label of priorityLabels) {
    const match = clean.match(new RegExp(label.source + String.raw`[^\d]{0,24}` + amount, "i"));
    const value = amountFromMatch(match);
    if (value) return value;
  }

  // If OCR puts label and value on separate lines.
  const lines = clean.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(?:grand\s*)?total\s*[:=-]?\s*$/i.test(lines[i]) && !/total\s*sale/i.test(lines[i + 1] || "")) {
      const match = (lines[i + 1] || "").match(new RegExp(amount, "i"));
      const value = amountFromMatch(match);
      if (value) return value;
    }
  }

  // Conservative fallback: largest non-tax decimal value, marked uncertain in the UI.
  const candidates = [];
  for (const line of lines) {
    if (/(?:total\s*sale|total\s*tax|subtotal|cgst|sgst|igst|cess|taxable\s*value)/i.test(line)) continue;
    for (const match of line.matchAll(/(?:Rs\.?|INR|₹)?\s*([\d,]+\.\d{2})/gi)) {
      const value = Number(match[1].replace(/,/g, ""));
      if (value > 0) candidates.push(value);
    }
  }
  return candidates.length ? Math.max(...candidates) : "";
}

function extractMerchant(text) {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/[|]/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean);
  const ignored = /^(tax invoice|original copy|invoice|receipt|page\s*no\.?|billing details|bill to|ship to|gstin|pan|mobile|phone|email|date|place of supply)\b/i;

  // Many invoice templates print the merchant after "Original Copy" and before the address/GST details.
  const flattened = lines.join(" ");
  const headerMatch = flattened.match(/(?:original\s+copy\s+)?([A-Z][A-Za-z0-9&.'() -]{2,45}?)(?=\s+\d{1,4}[\/-]\d|\s+\d{1,5},\s*[A-Z]|\s+GSTIN\b|\s+PAN\b|\s+Mobile\b)/i);
  if (headerMatch) {
    const candidate = headerMatch[1].replace(/^(tax invoice|invoice|receipt)\s*/i, "").trim();
    if (candidate.length >= 3 && !ignored.test(candidate)) return candidate;
  }

  for (const line of lines.slice(0, 15)) {
    const candidate = line.replace(/^(original copy|tax invoice|invoice|receipt)\s*/i, "").trim();
    if (candidate.length < 3 || candidate.length > 55 || ignored.test(candidate)) continue;
    if (/\b(gstin|mobile|phone|pan|invoice\s*(no|number)|date|address)\b/i.test(candidate)) continue;
    if (/^\W*\d/.test(candidate) || /\d{5,}/.test(candidate)) continue;
    if (/^(page|no\.?|copy|cash)$/i.test(candidate)) continue;
    return candidate;
  }
  return "";
}

function isLikelyBill(text) {
  const lower = text.toLowerCase();
  const signals = [
    /tax\s*invoice|invoice|receipt|cash\s*bill|bill\s*no/,
    /grand\s*total|total\s*amount|amount\s*payable|\btotal\b/,
    /\bgstin\b|\bcgst\b|\bsgst\b|\bigst\b/,
    /\bqty\b|\bquantity\b|\brate\b|\bunit price\b/,
    /\bsubtotal\b|\bpayment\b|\bbilling details\b/
  ];
  const signalCount = signals.filter((pattern) => pattern.test(lower)).length;
  const hasAmount = /(?:₹|rs\.?|inr)?\s*\d[\d,]*\.\d{2}/i.test(text);
  return signalCount >= 2 && hasAmount;
}

function suggestCategory(text) {
  const lower = text.toLowerCase();
  if (/electricity|water bill|internet|broadband|telephone|mobile recharge|gas bill|lpg/.test(lower)) return "Utilities";
  if (/rice|grocery|groceries|supermarket|vegetable|vegetables|fruit|fruits|oil|toothpaste|kirana|provision|atta|dal|pulses/.test(lower)) return "Groceries";
  return "Food";
}

function setReviewValues(text) {
  const merchant = extractMerchant(text);
  const date = extractDate(text);
  const total = extractTotal(text);
  const category = suggestCategory(text);

  $("merchant").value = merchant;
  $("date").value = date;
  $("total").value = total === "" ? "" : total;
  $("category").value = category;

  setFieldHint("merchant", merchant ? "Detected — please verify" : "Not found — enter it manually", !merchant);
  setFieldHint("date", date ? "Detected — please verify" : "Not found — enter it manually", !date);
  setFieldHint("total", total !== "" ? "Detected — please verify amount" : "Not found — enter it manually", total === "");
  setFieldHint("category", "Suggested from the bill text", false);

  $("confidence").textContent = "Please verify every field. OCR can misread blurry, angled or handwritten bills; you can edit the details before saving.";
  $("saveBtn").disabled = false;
}

$("billImage").addEventListener("change", (event) => {
  selectedFile = event.target.files?.[0] || null;
  currentScanValid = false;
  $("scanBtn").disabled = !selectedFile;
  $("saveBtn").disabled = true;
  $("ocrText").textContent = "No text detected yet.";
  $("confidence").textContent = "Scan a bill to extract its details.";
  if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
  $("preview").innerHTML = "";
  if (!selectedFile) {
    $("status").textContent = "Choose an image to get started.";
    return;
  }
  if (!selectedFile.type.startsWith("image/")) {
    selectedFile = null;
    $("scanBtn").disabled = true;
    $("status").textContent = "Please choose an image file.";
    return;
  }
  lastObjectUrl = URL.createObjectURL(selectedFile);
  const image = document.createElement("img");
  image.src = lastObjectUrl;
  image.alt = "Selected bill preview";
  $("preview").appendChild(image);
  $("status").textContent = "Image selected. Select Scan bill to continue.";
});

async function readImage(file) {
  if (!worker) {
    $("status").textContent = "Preparing text recognition for the first scan…";
    worker = await Tesseract.createWorker("eng");
  }
  const result = await worker.recognize(file);
  return result.data.text || "";
}

$("scanBtn").addEventListener("click", async () => {
  if (!selectedFile) return;
  $("scanBtn").disabled = true;
  $("saveBtn").disabled = true;
  currentScanValid = false;
  $("status").textContent = "Scanning image. Please wait…";
  try {
    const text = await readImage(selectedFile);
    $("ocrText").textContent = text || "No readable text was found.";
    if (!isLikelyBill(text)) {
      $("status").textContent = "This image does not appear to be a bill. Please upload a clear bill or receipt.";
      $("confidence").textContent = "No bill details were saved.";
      ["merchant", "date", "total"].forEach((field) => {
        $(field).value = "";
        setFieldHint(field, "Not available", true);
      });
      return;
    }
    setReviewValues(text);
    currentScanValid = true;
    $("status").textContent = "Bill detected. Review and correct the details below before saving.";
  } catch (error) {
    console.error("Bill Snap scan error:", error);
    $("status").textContent = "Scanning could not be completed. Check your internet connection for the first OCR language download, then try a JPG, PNG or WEBP image.";
    $("confidence").textContent = "If this image format is not supported by the browser/OCR engine, try converting it to JPG or PNG.";
  } finally {
    $("scanBtn").disabled = !selectedFile;
  }
});

$("saveBtn").addEventListener("click", async () => {
  if (!currentScanValid) {
    alert("Please scan and validate a bill before saving.");
    return;
  }
  const merchant = $("merchant").value.trim();
  const date = $("date").value;
  const total = Number($("total").value);
  const category = $("category").value;
  if (!merchant) { alert("Please enter the merchant name."); $("merchant").focus(); return; }
  if (!Number.isFinite(total) || total <= 0) { alert("Please enter a valid total amount."); $("total").focus(); return; }

  $("saveBtn").disabled = true;
  try {
    await saveToDatabase({ merchant, date, total, category, createdAt: new Date().toISOString() });
    alert("Bill saved successfully on this device.");
    $("merchant").value = "";
    $("date").value = "";
    $("total").value = "";
    $("category").value = "Food";
    ["merchant", "date", "total"].forEach((field) => setFieldHint(field, "Not scanned yet", false));
    $("confidence").textContent = "Scan another bill whenever you are ready.";
    $("status").textContent = "Your bill has been saved.";
    $("saveBtn").disabled = true;
    currentScanValid = false;
    await displayBills();
  } catch (error) {
    console.error("Bill Snap save error:", error);
    alert("Could not save the bill. Please try again.");
    $("saveBtn").disabled = false;
  }
});

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => console.warn("Service worker registration failed:", error));
  });
}

displayBills();
