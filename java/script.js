
(function () {
  "use strict";

  // ---------- state ----------
  var products = {};          // barcode -> {barcode, name, quantity, sector, updatedAt}
  var db = null;
  var unsub = null;
  var html5Qr = null;
  var scanning = false;
  var pendingBarcode = null;
  var pendingMode = "scan";   // "scan" (new/add) | "edit"
  var lastScanTime = 0;
  var activeSector = "todos";

  var SECTORS = [
    { id: "todos", label: "Todos" },
    { id: "alimentos1", label: "Alimentos 1" },
    { id: "alimentos2", label: "Alimentos 2" },
    { id: "bebidas1", label: "Bebidas 1" },
    { id: "bebidas2", label: "Bebidas 2" },
    { id: "limpieza1", label: "Limpieza 1" },
    { id: "limpieza2", label: "Limpieza 2" }
  ];
  var SECTOR_LABEL = {
    alimentos1: "Alimentos 1", alimentos2: "Alimentos 2",
    bebidas1: "Bebidas 1", bebidas2: "Bebidas 2",
    limpieza1: "Limpieza 1", limpieza2: "Limpieza 2"
  };
  var SECTOR_ORDER = ["alimentos1", "alimentos2", "bebidas1", "bebidas2", "limpieza1", "limpieza2", "sinsector"];
  function isFoodOrCleaning(sector) {
    return /^alimentos/.test(sector) || /^limpieza/.test(sector);
  }

  var LOCAL_KEY = "registro-productos:data";
  var LOGO_KEY = "registro-productos:logo";
  var DAYS_KEY = "registro-productos:alertdays";
  var logoDataUrl = null;
  var splashShownAt = Date.now();
  var expiryFilter = "todos"; // "todos" | "vencidos" | "proximos"
  var alertDays = 30;

  // ---------- helpers ----------
  function toast(msg) {
    var t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._h);
    toast._h = setTimeout(function () { t.classList.remove("show"); }, 2200);
  }

  function vibrate() {
    try { if (navigator.vibrate) navigator.vibrate(60); } catch (e) {}
  }

  function saveLocal() {
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(products)); } catch (e) {}
  }
  function loadLocal() {
    try {
      var raw = localStorage.getItem(LOCAL_KEY);
      if (raw) products = JSON.parse(raw) || {};
    } catch (e) { products = {}; }
  }

  function sanitizeId(code) {
    return String(code).trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
  }

  // ---------- vencimientos ----------
  function daysUntil(dateStr) {
    if (!dateStr) return null;
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var parts = dateStr.split("-");
    var target = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    return Math.round((target - today) / 86400000);
  }

  function expiryState(dateStr) {
    var d = daysUntil(dateStr);
    if (d === null) return "none";
    if (d < 0) return "vencido";
    if (d <= alertDays) return "proximo";
    return "ok";
  }

  function formatDate(dateStr) {
    var parts = dateStr.split("-");
    return parts[2] + "/" + parts[1] + "/" + parts[0];
  }

  function expiryBadgeHtml(p) {
    if (!p.expiry) return "";
    var state = expiryState(p.expiry);
    var d = daysUntil(p.expiry);
    var cls = state === "vencido" ? "vencido" : (state === "proximo" ? "proximo" : "ok");
    var txt;
    if (state === "vencido") txt = "Vencido hace " + Math.abs(d) + "d";
    else if (state === "proximo") txt = "Vence en " + d + "d";
    else txt = "Vence " + formatDate(p.expiry);
    return '<span class="expiry-badge ' + cls + '">' + txt + '</span>';
  }

  var ALTURA_LABEL = { alto: "Alto", medio: "Medio", bajo: "Bajo" };

  function locationText(p) {
    if (!p.locSector && !p.locAltura) return "";
    var parts = [];
    if (p.locSector) parts.push("Sector " + p.locSector);
    if (p.locAltura) parts.push(ALTURA_LABEL[p.locAltura] || p.locAltura);
    return parts.join(" · ");
  }

  function locationBadgeHtml(p) {
    var txt = locationText(p);
    if (!txt) return "";
    return '<span class="location-badge">📍 ' + txt + '</span>';
  }

  function loadAlertDays() {
    try {
      var v = parseInt(localStorage.getItem(DAYS_KEY), 10);
      if (v && v > 0) alertDays = v;
    } catch (e) {}
    document.getElementById("alert-days").value = alertDays;
  }

  document.getElementById("alert-days").addEventListener("change", function () {
    var v = parseInt(this.value, 10);
    if (!v || v < 1) v = 30;
    alertDays = v;
    try { localStorage.setItem(DAYS_KEY, String(v)); } catch (e) {}
    render();
  });

  document.querySelectorAll(".expiry-chip").forEach(function (btn) {
    btn.addEventListener("click", function () {
      expiryFilter = btn.getAttribute("data-filter");
      render();
    });
  });

  document.getElementById("expiry-alert").addEventListener("click", function () {
    expiryFilter = "vencidos";
    activeSector = "todos";
    render();
    document.getElementById("product-list").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  function renderTabs() {
    var wrap = document.getElementById("sector-tabs");
    wrap.innerHTML = "";
    SECTORS.forEach(function (s) {
      var items = Object.keys(products).map(function (k) { return products[k]; })
        .filter(function (p) { return s.id === "todos" || p.sector === s.id; });
      var units = 0;
      items.forEach(function (p) { units += (p.quantity || 0); });

      var btn = document.createElement("button");
      btn.className = "sector-tab" + (activeSector === s.id ? " active" : "");
      btn.setAttribute("data-sector", s.id);
      btn.innerHTML = '<span class="dot"></span><span class="lbl"></span><span class="count"></span>';
      btn.querySelector(".lbl").textContent = s.label;
      btn.querySelector(".count").textContent = items.length + " · " + units + "u";
      btn.addEventListener("click", function () {
        activeSector = s.id;
        render();
      });
      wrap.appendChild(btn);
    });
  }

  function render() {
    renderTabs();

    var list = document.getElementById("product-list");
    var empty = document.getElementById("empty-msg");
    var search = (document.getElementById("search").value || "").toLowerCase().trim();

    var allItems = Object.keys(products).map(function (k) { return products[k]; });

    // ---- global expiry counts (independent of sector/search filters) ----
    var vencidosAll = allItems.filter(function (p) { return expiryState(p.expiry) === "vencido"; });
    var proximosAll = allItems.filter(function (p) { return expiryState(p.expiry) === "proximo"; });

    var banner = document.getElementById("expiry-alert");
    if (vencidosAll.length || proximosAll.length) {
      var parts = [];
      if (vencidosAll.length) parts.push("<b>" + vencidosAll.length + "</b> vencido" + (vencidosAll.length > 1 ? "s" : ""));
      if (proximosAll.length) parts.push("<b>" + proximosAll.length + "</b> por vencer en " + alertDays + " días");
      document.getElementById("expiry-alert-text").innerHTML = parts.join(" · ") + " — tocá para ver";
      banner.classList.add("show");
    } else {
      banner.classList.remove("show");
    }

    document.querySelectorAll(".expiry-chip").forEach(function (btn) {
      var f = btn.getAttribute("data-filter");
      btn.classList.toggle("active", expiryFilter === f);
      if (f === "vencidos") btn.querySelector(".n").textContent = vencidosAll.length ? "(" + vencidosAll.length + ")" : "";
      if (f === "proximos") btn.querySelector(".n").textContent = proximosAll.length ? "(" + proximosAll.length + ")" : "";
    });

    // ---- apply sector filter ----
    var items = allItems;
    if (activeSector !== "todos") {
      items = items.filter(function (p) { return p.sector === activeSector; });
    }

    // ---- apply expiry filter ----
    if (expiryFilter === "vencidos") {
      items = items.filter(function (p) { return expiryState(p.expiry) === "vencido"; });
    } else if (expiryFilter === "proximos") {
      items = items.filter(function (p) { return expiryState(p.expiry) === "proximo"; });
    }

    var statItems = items.slice();
    var totalUnits = 0;
    statItems.forEach(function (p) { totalUnits += (p.quantity || 0); });
    document.getElementById("stat-skus").textContent = statItems.length;
    document.getElementById("stat-units").textContent = totalUnits;

    items.sort(function (a, b) {
      var da = daysUntil(a.expiry), db = daysUntil(b.expiry);
      if (da !== null && db !== null && da !== db) return da - db;
      if (da !== null && db === null) return -1;
      if (da === null && db !== null) return 1;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });

    if (search) {
      items = items.filter(function (p) {
        return (p.name || "").toLowerCase().indexOf(search) !== -1 ||
               (p.barcode || "").toLowerCase().indexOf(search) !== -1;
      });
    }

    list.innerHTML = "";
    empty.style.display = items.length === 0 ? "block" : "none";

    items.forEach(function (p) {
      var row = document.createElement("div");
      row.className = "product";
      var sectorLabel = SECTOR_LABEL[p.sector] || "Sin sector";
      row.innerHTML =
        '<div class="info">' +
          '<div class="name"></div>' +
          '<div class="meta">' +
            '<span class="sector-badge" data-sector="' + (p.sector || "") + '"><span class="dot"></span><span class="slabel"></span></span>' +
            '<span class="code-text"></span>' +
            expiryBadgeHtml(p) +
            locationBadgeHtml(p) +
          '</div>' +
        '</div>' +
        '<div class="qty-ctrl">' +
          '<button class="minus" aria-label="Restar uno">−</button>' +
          '<div class="q"></div>' +
          '<button class="plus" aria-label="Sumar uno">+</button>' +
        '</div>' +
        '<button class="edit-btn" aria-label="Editar">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>' +
          '</svg>' +
        '</button>' +
        '<button class="del-btn" aria-label="Eliminar">✕</button>';

      row.querySelector(".name").textContent = p.name || "(sin nombre)";
      row.querySelector(".slabel").textContent = sectorLabel;
      row.querySelector(".code-text").textContent = p.barcode;
      row.querySelector(".q").textContent = p.quantity || 0;

      row.querySelector(".minus").addEventListener("click", function () {
        changeQty(p.barcode, -1);
      });
      row.querySelector(".plus").addEventListener("click", function () {
        changeQty(p.barcode, 1);
      });
      row.querySelector(".edit-btn").addEventListener("click", function () {
        openModal(p.barcode, "edit");
      });
      row.querySelector(".del-btn").addEventListener("click", function () {
        if (confirm('¿Eliminar "' + (p.name || p.barcode) + '" del registro?')) {
          removeProduct(p.barcode);
        }
      });

      list.appendChild(row);
    });
  }

  // ---------- persistence (db capability with local fallback) ----------
  function upsertProduct(barcode, patch) {
    var existing = products[barcode] || { barcode: barcode, name: "", quantity: 0 };
    var next = Object.assign({}, existing, patch, { updatedAt: Date.now() });
    products[barcode] = next;
    render();
    saveLocal();
    if (db) {
      db.doc("products/" + sanitizeId(barcode)).set(next).catch(function (e) {
        console.error("db set failed", e);
      });
    }
  }

  function removeProduct(barcode) {
    delete products[barcode];
    render();
    saveLocal();
    if (db) {
      db.doc("products/" + sanitizeId(barcode)).delete().catch(function (e) {
        console.error("db delete failed", e);
      });
    }
  }

  function changeQty(barcode, delta) {
    var p = products[barcode];
    if (!p) return;
    var q = Math.max(0, (p.quantity || 0) + delta);
    upsertProduct(barcode, { name: p.name, quantity: q });
  }

  async function initDb() {
    try {
      db = await claude.use("db");
    } catch (e) {
      db = null;
    }
    var tag = document.getElementById("synctag");
    if (!db) {
      tag.textContent = "local";
      return;
    }
    tag.textContent = "sincronizado";
    try {
      unsub = db.collection("products").onSnapshot(function (snap) {
        var next = {};
        snap.forEach(function (doc) {
          var data = doc.data ? doc.data() : doc;
          if (data && data.barcode) next[data.barcode] = data;
        });
        products = next;
        render();
        saveLocal();
      });
    } catch (e) {
      console.error("subscribe failed", e);
    }
  }

  // ---------- modal ----------
  function openModal(barcode, mode) {
    pendingBarcode = barcode;
    pendingMode = mode || "scan";
    var existing = products[barcode];
    var qtyLabel = document.getElementById("modal-qty-label");
    var qtyInput = document.getElementById("modal-qty");
    var sectorSelect = document.getElementById("modal-sector");

    if (pendingMode === "edit" && existing) {
      document.getElementById("modal-title").textContent = "Editar producto";
      qtyLabel.textContent = "Cantidad en stock";
      qtyInput.min = "0";
      qtyInput.value = existing.quantity || 0;
      sectorSelect.value = existing.sector || "alimentos1";
    } else if (existing) {
      document.getElementById("modal-title").textContent = "Sumar unidades";
      qtyLabel.textContent = "Cantidad a sumar";
      qtyInput.min = "1";
      qtyInput.value = 1;
      sectorSelect.value = existing.sector || "alimentos1";
    } else {
      document.getElementById("modal-title").textContent = "Producto nuevo";
      qtyLabel.textContent = "Cantidad inicial";
      qtyInput.min = "1";
      qtyInput.value = 1;
      sectorSelect.value = activeSector !== "todos" ? activeSector : "alimentos1";
    }

    document.getElementById("modal-code").textContent = barcode;
    document.getElementById("modal-name").value = existing ? existing.name || "" : "";
    document.getElementById("modal-expiry").value = existing ? existing.expiry || "" : "";
    document.getElementById("modal-locsector").value = existing ? existing.locSector || "" : "";
    document.getElementById("modal-localtura").value = existing ? existing.locAltura || "" : "";
    toggleLocationFields();
    document.getElementById("modal-backdrop").classList.add("active");
    setTimeout(function () {
      var nameField = document.getElementById("modal-name");
      if (!existing || pendingMode === "edit") nameField.focus();
    }, 50);
  }

  function toggleLocationFields() {
    var sector = document.getElementById("modal-sector").value;
    var wrap = document.getElementById("modal-location");
    wrap.classList.toggle("show", isFoodOrCleaning(sector));
  }
  document.getElementById("modal-sector").addEventListener("change", toggleLocationFields);

  function closeModal() {
    document.getElementById("modal-backdrop").classList.remove("active");
    pendingBarcode = null;
  }

  document.getElementById("modal-cancel").addEventListener("click", closeModal);
  document.getElementById("modal-backdrop").addEventListener("click", function (e) {
    if (e.target === this) closeModal();
  });
  document.getElementById("modal-save").addEventListener("click", function () {
    if (!pendingBarcode) return;
    var name = document.getElementById("modal-name").value.trim();
    var sector = document.getElementById("modal-sector").value;
    var expiry = document.getElementById("modal-expiry").value || null;
    var qtyVal = parseInt(document.getElementById("modal-qty").value, 10);
    if (!name) { toast("Poné un nombre para el producto"); return; }
    if (isNaN(qtyVal) || qtyVal < 0) qtyVal = 0;

    var usesLocation = isFoodOrCleaning(sector);
    var locSector = usesLocation ? document.getElementById("modal-locsector").value.trim() || null : null;
    var locAltura = usesLocation ? document.getElementById("modal-localtura").value || null : null;

    var existing = products[pendingBarcode];
    var finalQty;
    if (pendingMode === "edit") {
      finalQty = qtyVal;
    } else {
      if (qtyVal < 1) qtyVal = 1;
      finalQty = (existing ? existing.quantity || 0 : 0) + qtyVal;
    }

    upsertProduct(pendingBarcode, {
      name: name, sector: sector, quantity: finalQty, expiry: expiry,
      locSector: locSector, locAltura: locAltura
    });
    toast((pendingMode === "edit" ? "Actualizado: " : (existing ? "Sumado a: " : "Registrado: ")) + name);
    closeModal();
  });

  // ---------- scanning ----------
  function onScanSuccess(decodedText) {
    var now = Date.now();
    if (now - lastScanTime < 1500) return; // debounce repeated frames
    lastScanTime = now;
    vibrate();
    stopScan();
    handleBarcode(decodedText);
  }

  function handleBarcode(code) {
    code = String(code).trim();
    if (!code) return;
    if (code.indexOf("DQ::") === 0) {
      toast("Ese es un código de transferencia. Usá \"⇄ PASAR A OTRO DISPOSITIVO\".");
      return;
    }
    openModal(code);
  }

  function cameraErrorMessage(err) {
    var name = (err && (err.name || err.message || "")) + "";
    if (/NotAllowedError|Permission/i.test(name)) {
      return "Le negaste el permiso de cámara al navegador. Habilitalo en el ícono del candado de la barra de direcciones y volvé a intentar.";
    }
    if (/NotFoundError|DevicesNotFound/i.test(name)) {
      return "No se encontró ninguna cámara en este dispositivo.";
    }
    if (/NotReadableError|TrackStart/i.test(name)) {
      return "La cámara está siendo usada por otra app. Cerrala e intentá de nuevo.";
    }
    if (/OverconstrainedError/i.test(name)) {
      return "No se pudo usar la cámara trasera. Probando con otra cámara disponible...";
    }
    if (/insecure|SecurityError/i.test(name)) {
      return "El navegador bloqueó la cámara en esta vista. Abrí el enlace publicado directamente (no la vista previa) e intentá otra vez.";
    }
    return "No se pudo acceder a la cámara. Usá el campo manual.";
  }

  function startScan() {
    var wrap = document.getElementById("reader-wrap");

    if (typeof Html5Qrcode === "undefined") {
      toast("No se pudo cargar el lector de cámara. Usá el campo manual.");
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast("Este navegador no permite acceso a la cámara acá. Abrí el enlace publicado directamente e intentá de nuevo.");
      return;
    }

    wrap.classList.add("active");
    scanning = true;
    var hint = document.getElementById("scan-hint");
    hint.textContent = "Solicitando permiso de cámara...";

    var formats = (typeof Html5QrcodeSupportedFormats !== "undefined") ? [
      Html5QrcodeSupportedFormats.EAN_13,
      Html5QrcodeSupportedFormats.EAN_8,
      Html5QrcodeSupportedFormats.UPC_A,
      Html5QrcodeSupportedFormats.UPC_E,
      Html5QrcodeSupportedFormats.UPC_EAN_EXTENSION,
      Html5QrcodeSupportedFormats.CODE_128,
      Html5QrcodeSupportedFormats.CODE_39,
      Html5QrcodeSupportedFormats.CODE_93,
      Html5QrcodeSupportedFormats.CODABAR,
      Html5QrcodeSupportedFormats.ITF,
      Html5QrcodeSupportedFormats.QR_CODE
    ] : undefined;

    html5Qr = new Html5Qrcode("reader", formats ? { formatsToSupport: formats, verbose: false } : { verbose: false });
    var config = { fps: 12, qrbox: { width: 280, height: 160 } };

    function tryStart(target) {
      return html5Qr.start(target, config, onScanSuccess, function () { /* per-frame no-match, ignore */ });
    }

    tryStart({ facingMode: "environment" }).then(function () {
      hint.textContent = "Apuntá la cámara al código de barras";
    }).catch(function (err) {
      console.error("environment camera failed", err);
      toast(cameraErrorMessage(err));
      // fall back: enumerate cameras and try the last one (often the back camera on phones)
      Html5Qrcode.getCameras().then(function (cams) {
        if (!cams || !cams.length) {
          toast("No se encontró ninguna cámara disponible.");
          stopScan();
          return;
        }
        var choice = cams.find(function (c) { return /back|rear|environment/i.test(c.label); }) || cams[cams.length - 1];
        tryStart(choice.id).then(function () {
          hint.textContent = "Apuntá la cámara al código de barras";
        }).catch(function (err2) {
          console.error("fallback camera failed", err2);
          toast(cameraErrorMessage(err2));
          stopScan();
        });
      }).catch(function (err3) {
        console.error("getCameras failed", err3);
        toast(cameraErrorMessage(err3));
        stopScan();
      });
    });
  }

  function stopScan() {
    var wrap = document.getElementById("reader-wrap");
    wrap.classList.remove("active");
    scanning = false;
    if (html5Qr) {
      html5Qr.stop().then(function () {
        html5Qr.clear();
        html5Qr = null;
      }).catch(function () { html5Qr = null; });
    }
  }

  document.getElementById("btn-scan").addEventListener("click", function () {
    if (scanning) { stopScan(); return; }
    startScan();
  });
  document.getElementById("btn-cancel-scan").addEventListener("click", stopScan);

  document.getElementById("btn-manual").addEventListener("click", function () {
    var v = document.getElementById("manual-code").value.trim();
    if (!v) { toast("Escribí un código"); return; }
    handleBarcode(v);
    document.getElementById("manual-code").value = "";
  });
  document.getElementById("manual-code").addEventListener("keydown", function (e) {
    if (e.key === "Enter") document.getElementById("btn-manual").click();
  });

  document.getElementById("search").addEventListener("input", render);

  // ---------- export: print / pdf ----------
  function totals() {
    var items = Object.keys(products).map(function (k) { return products[k]; });
    var totalUnits = 0;
    items.forEach(function (p) { totalUnits += (p.quantity || 0); });
    return { skus: items.length, units: totalUnits, items: items };
  }

  function bySector() {
    var groups = {};
    SECTOR_ORDER.forEach(function (id) { groups[id] = []; });
    Object.keys(products).forEach(function (k) {
      var p = products[k];
      var key = groups[p.sector] ? p.sector : "sinsector";
      groups[key].push(p);
    });
    Object.keys(groups).forEach(function (k) {
      groups[k].sort(function (a, b) { return (a.name || "").localeCompare(b.name || "", "es"); });
    });
    return groups;
  }

  function fechaHoy() {
    return new Date().toLocaleString("es-AR", {
      day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit"
    });
  }

  function sectorTitle(key) {
    return SECTOR_LABEL[key] || "Sin sector asignado";
  }

  function expiryCellText(p) {
    if (!p.expiry) return "—";
    var state = expiryState(p.expiry);
    var d = daysUntil(p.expiry);
    if (state === "vencido") return formatDate(p.expiry) + " (vencido hace " + Math.abs(d) + "d)";
    if (state === "proximo") return formatDate(p.expiry) + " (en " + d + "d)";
    return formatDate(p.expiry);
  }

  function buildAlertsSectionHtml() {
    var all = Object.keys(products).map(function (k) { return products[k]; });
    var vencidos = all.filter(function (p) { return expiryState(p.expiry) === "vencido"; });
    var proximos = all.filter(function (p) { return expiryState(p.expiry) === "proximo"; });
    if (!vencidos.length && !proximos.length) return "";

    function rowsFor(items) {
      return items.map(function (p) {
        return "<tr><td>" + escapeHtml(p.barcode) + "</td><td>" + escapeHtml(p.name || "") +
          "</td><td>" + (SECTOR_LABEL[p.sector] || "—") + "</td><td>" + expiryCellText(p) + "</td></tr>";
      }).join("");
    }

    var html = "<h2>⚠ Alertas de vencimiento</h2><table>" +
      "<thead><tr><th>Código</th><th>Producto</th><th>Sector</th><th>Vencimiento</th></tr></thead><tbody>" +
      rowsFor(vencidos) + rowsFor(proximos) + "</tbody></table>";
    return html;
  }

  function buildPrintReport() {
    var t = totals();
    var groups = bySector();
    var order = SECTOR_ORDER;

    var sectionsHtml = order.map(function (key) {
      var items = groups[key];
      if (!items.length) return "";
      var units = 0;
      var showLoc = isFoodOrCleaning(key);
      var rows = items.map(function (p) {
        units += (p.quantity || 0);
        return "<tr><td>" + escapeHtml(p.barcode) + "</td><td>" + escapeHtml(p.name || "") +
          "</td><td>" + (p.quantity || 0) + "</td><td>" + expiryCellText(p) + "</td>" +
          (showLoc ? "<td>" + escapeHtml(locationText(p) || "—") + "</td>" : "") + "</tr>";
      }).join("");
      return "<h2>" + sectorTitle(key) + " &middot; " + items.length + " productos &middot; " + units + " unidades</h2>" +
        "<table>" +
          "<thead><tr><th>Código</th><th>Producto</th><th>Cantidad</th><th>Vencimiento</th>" +
          (showLoc ? "<th>Ubicación</th>" : "") + "</tr></thead>" +
          "<tbody>" + rows + "</tbody>" +
        "</table>";
    }).join("");

    var logoHtml = logoDataUrl ? "<img class=\"print-logo\" src=\"" + logoDataUrl + "\" alt=\"Logo\">" : "";

    document.getElementById("print-report").innerHTML =
      "<div class=\"print-head\">" + logoHtml + "<h1>Control de depósito por sector</h1></div>" +
      "<div class=\"meta\">Generado: " + fechaHoy() + " &middot; alerta de vencimiento: " + alertDays + " días</div>" +
      buildAlertsSectionHtml() +
      (sectionsHtml || "<p>Sin productos registrados.</p>") +
      "<div class=\"grand-total\">Total general: " + t.skus + " productos &middot; " + t.units + " unidades</div>";
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  document.getElementById("btn-print").addEventListener("click", function () {
    buildPrintReport();
    setTimeout(function () { window.print(); }, 50);
  });

  function imageFormat(dataUrl) {
    return /^data:image\/png/i.test(dataUrl) ? "PNG" : "JPEG";
  }

  function loadImageSize(dataUrl) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve({ width: img.naturalWidth, height: img.naturalHeight }); };
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  async function downloadPdf() {
    if (typeof window.jspdf === "undefined") {
      toast("No se pudo cargar el generador de PDF.");
      return;
    }
    var t = totals();
    var groups = bySector();
    var order = SECTOR_ORDER;
    var jsPDF = window.jspdf.jsPDF;
    var doc = new jsPDF();

    var titleX = 14;
    var titleY = 18;
    var cursorY = 32;

    if (logoDataUrl) {
      try {
        var size = await loadImageSize(logoDataUrl);
        var maxW = 26, maxH = 16;
        var scale = Math.min(maxW / size.width, maxH / size.height);
        var w = size.width * scale, h = size.height * scale;
        doc.addImage(logoDataUrl, imageFormat(logoDataUrl), 14, 10, w, h);
        titleX = 14 + w + 8;
        titleY = 10 + h / 2 + 3;
        cursorY = Math.max(32, 10 + h + 10);
      } catch (e) {
        console.error("logo render failed", e);
      }
    }

    doc.setFontSize(16);
    doc.text("Control de depósito por sector", titleX, titleY);
    doc.setFontSize(9);
    doc.setTextColor(110);
    doc.text("Generado: " + fechaHoy() + "  ·  alerta: " + alertDays + " días", titleX, titleY + 7);
    doc.setTextColor(0);

    function colorCellByStatus(data, statuses) {
      if (data.section === "body") {
        var st = statuses[data.row.index];
        if (st === "vencido") { data.cell.styles.textColor = [167, 64, 47]; data.cell.styles.fontStyle = "bold"; }
        else if (st === "proximo") { data.cell.styles.textColor = [156, 94, 20]; }
      }
    }

    var allItems = Object.keys(products).map(function (k) { return products[k]; });
    var vencidos = allItems.filter(function (p) { return expiryState(p.expiry) === "vencido"; });
    var proximos = allItems.filter(function (p) { return expiryState(p.expiry) === "proximo"; });

    if (vencidos.length || proximos.length) {
      var alertItems = vencidos.concat(proximos);
      var alertStatuses = alertItems.map(function (p) { return expiryState(p.expiry); });
      var alertBody = alertItems.map(function (p) {
        return [p.barcode, p.name || "", SECTOR_LABEL[p.sector] || "—", expiryCellText(p)];
      });

      doc.setFontSize(11);
      doc.setFont(undefined, "bold");
      doc.setTextColor(167, 64, 47);
      doc.text("⚠ Alertas de vencimiento (" + alertItems.length + ")", 14, cursorY);
      doc.setTextColor(0);
      doc.setFont(undefined, "normal");

      doc.autoTable({
        startY: cursorY + 4,
        head: [["Código", "Producto", "Sector", "Vencimiento"]],
        body: alertBody,
        styles: { font: "helvetica", fontSize: 9, cellPadding: 3 },
        headStyles: { fillColor: [167, 64, 47], textColor: 255 },
        didParseCell: function (data) { colorCellByStatus(data, alertStatuses); },
        margin: { top: 20 }
      });
      cursorY = doc.lastAutoTable.finalY + 14;
    }

    order.forEach(function (key) {
      var items = groups[key];
      if (!items.length) return;
      var units = 0;
      var showLoc = isFoodOrCleaning(key);
      var statuses = items.map(function (p) { return expiryState(p.expiry); });
      var body = items.map(function (p) {
        units += (p.quantity || 0);
        var row = [p.barcode, p.name || "", String(p.quantity || 0), expiryCellText(p)];
        if (showLoc) row.push(locationText(p) || "—");
        return row;
      });
      var head = showLoc
        ? ["Código", "Producto", "Cantidad", "Vencimiento", "Ubicación"]
        : ["Código", "Producto", "Cantidad", "Vencimiento"];

      doc.setFontSize(11);
      doc.setFont(undefined, "bold");
      doc.text(sectorTitle(key) + "  (" + items.length + " productos, " + units + " unidades)", 14, cursorY);
      doc.setFont(undefined, "normal");

      doc.autoTable({
        startY: cursorY + 4,
        head: [head],
        body: body,
        styles: { font: "helvetica", fontSize: 9, cellPadding: 3 },
        headStyles: { fillColor: [28, 26, 23], textColor: 255 },
        columnStyles: { 2: { halign: "right" } },
        didParseCell: function (data) { colorCellByStatus(data, statuses); },
        margin: { top: 20 }
      });
      cursorY = doc.lastAutoTable.finalY + 12;
    });

    doc.setFontSize(10);
    doc.setFont(undefined, "bold");
    doc.text("Total general: " + t.skus + " productos, " + t.units + " unidades", 14, cursorY);

    var blob = doc.output("blob");
    var filename = "deposito-por-sector-" + new Date().toISOString().slice(0, 10) + ".pdf";

    var downloads = null;
    try { downloads = await claude.use("downloads"); } catch (e) { downloads = null; }

    if (downloads) {
      try {
        await downloads.save({ filename: filename, data: blob });
        toast("PDF listo para guardar");
        return;
      } catch (e) {
        console.error("downloads.save failed", e);
      }
    }

    // fallback if the downloads capability isn't available in this view
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  document.getElementById("btn-pdf").addEventListener("click", downloadPdf);

  // ---------- logo ----------
  function saveLogoLocal() {
    try {
      if (logoDataUrl) localStorage.setItem(LOGO_KEY, logoDataUrl);
      else localStorage.removeItem(LOGO_KEY);
    } catch (e) {}
  }
  function loadLogoLocal() {
    try { return localStorage.getItem(LOGO_KEY); } catch (e) { return null; }
  }

  function applyLogo() {
    var img = document.getElementById("brand-logo");
    var preview = document.getElementById("logo-preview");
    if (logoDataUrl) {
      img.src = logoDataUrl;
      img.classList.add("set");
      preview.src = logoDataUrl;
      preview.classList.add("set");
    } else {
      img.classList.remove("set");
      img.removeAttribute("src");
      preview.classList.remove("set");
      preview.removeAttribute("src");
    }
  }

  function setLogo(dataUrl) {
    logoDataUrl = dataUrl;
    applyLogo();
    saveLogoLocal();
    if (db) {
      db.doc("settings/logo").set({ dataUrl: dataUrl, updatedAt: Date.now() }).catch(function (e) {
        console.error("logo db save failed", e);
      });
    }
  }

  async function initLogo() {
    var local = loadLogoLocal();
    if (local) { logoDataUrl = local; applyLogo(); }
    if (db) {
      try {
        db.doc("settings/logo").onSnapshot(function (doc) {
          var data = doc && doc.data ? doc.data() : doc;
          if (data && data.dataUrl && data.dataUrl !== logoDataUrl) {
            logoDataUrl = data.dataUrl;
            applyLogo();
            saveLogoLocal();
          }
        });
      } catch (e) { /* no shared logo yet or not supported */ }
    }
  }

  document.getElementById("btn-logo").addEventListener("click", function () {
    document.getElementById("logo-modal-backdrop").classList.add("active");
  });
  document.getElementById("logo-cancel").addEventListener("click", function () {
    document.getElementById("logo-modal-backdrop").classList.remove("active");
  });
  document.getElementById("logo-modal-backdrop").addEventListener("click", function (e) {
    if (e.target === this) this.classList.remove("active");
  });
  document.getElementById("logo-remove").addEventListener("click", function () {
    setLogo(null);
    document.getElementById("logo-file").value = "";
    toast("Logo quitado");
  });
  document.getElementById("logo-file").addEventListener("change", function (e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    if (file.size > 1.5 * 1024 * 1024) {
      toast("La imagen es muy pesada, probá con una de menos de 1.5 MB");
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      setLogo(reader.result);
      toast("Logo actualizado");
    };
    reader.onerror = function () { toast("No se pudo leer la imagen"); };
    reader.readAsDataURL(file);
  });

  // ---------- transferir por QR ----------
  var QR_CHUNK_SIZE = 320;
  var qrChunks = [];
  var qrIndex = 0;
  var qrTimer = null;
  var qrPlaying = true;

  var recvQr = null;
  var recvActive = false;
  var recvTransferId = null;
  var recvTotal = 0;
  var recvChunks = {};
  var recvLastScan = 0;

  function randomId() {
    return Math.random().toString(36).slice(2, 6).toUpperCase();
  }

  function buildTransferPayload() {
    var items = Object.keys(products).map(function (k) {
      var p = products[k];
      return [p.barcode, p.name || "", p.sector || "", p.quantity || 0, p.expiry || "", p.locSector || "", p.locAltura || ""];
    });
    return JSON.stringify({ t: "deposito-transfer", v: 1, ts: Date.now(), items: items });
  }

  function buildQrChunks() {
    var json = buildTransferPayload();
    var id = randomId();
    var parts = [];
    for (var i = 0; i < json.length; i += QR_CHUNK_SIZE) {
      parts.push(json.slice(i, i + QR_CHUNK_SIZE));
    }
    if (parts.length === 0) parts = [""];
    var total = parts.length;
    return parts.map(function (chunk, idx) {
      return "DQ::" + id + "::" + idx + "::" + total + "::" + chunk;
    });
  }

  function renderQrFrame() {
    var canvas = document.getElementById("qr-canvas");
    var text = qrChunks[qrIndex];
    if (typeof QRCode === "undefined") {
      document.getElementById("qr-progress").textContent = "No se pudo cargar el generador de QR.";
      return;
    }
    QRCode.toCanvas(canvas, text, { width: 240, margin: 1 }, function (err) {
      if (err) console.error(err);
    });
    document.getElementById("qr-progress").textContent =
      "Mostrando código " + (qrIndex + 1) + " de " + qrChunks.length +
      (qrChunks.length > 1 ? "  ·  se cambia solo" : "");
  }

  function qrAdvance() {
    qrIndex = (qrIndex + 1) % qrChunks.length;
    renderQrFrame();
  }

  function startQrSlideshow() {
    qrChunks = buildQrChunks();
    qrIndex = 0;
    qrPlaying = true;
    renderQrFrame();
    document.getElementById("qr-controls").style.display = qrChunks.length > 1 ? "flex" : "none";
    document.getElementById("qr-playpause").textContent = "Pausar";
    clearInterval(qrTimer);
    if (qrChunks.length > 1) {
      qrTimer = setInterval(function () { if (qrPlaying) qrAdvance(); }, 1100);
    }
  }

  function stopQrSlideshow() {
    clearInterval(qrTimer);
    qrTimer = null;
  }

  document.getElementById("qr-prev").addEventListener("click", function () {
    qrIndex = (qrIndex - 1 + qrChunks.length) % qrChunks.length;
    renderQrFrame();
  });
  document.getElementById("qr-next").addEventListener("click", qrAdvance);
  document.getElementById("qr-playpause").addEventListener("click", function () {
    qrPlaying = !qrPlaying;
    this.textContent = qrPlaying ? "Pausar" : "Seguir";
  });

  function resetRecvState() {
    recvTransferId = null;
    recvTotal = 0;
    recvChunks = {};
    document.getElementById("recv-progress-fill").style.width = "0%";
    document.getElementById("recv-summary").style.display = "none";
    document.getElementById("recv-status").textContent = "Tocá \"Empezar a recibir\" y apuntá al otro dispositivo";
  }

  function onRecvChunk(decoded) {
    var now = Date.now();
    if (now - recvLastScan < 120) return;
    recvLastScan = now;

    if (decoded.indexOf("DQ::") !== 0) return; // no es un código de transferencia
    var parts = decoded.split("::");
    if (parts.length < 5) return;
    var id = parts[1], idx = parseInt(parts[2], 10), total = parseInt(parts[3], 10);
    var chunk = parts.slice(4).join("::");

    if (recvTransferId && recvTransferId !== id) {
      // empezó una transferencia nueva: reiniciamos
      recvChunks = {};
    }
    recvTransferId = id;
    recvTotal = total;
    recvChunks[idx] = chunk;

    var got = Object.keys(recvChunks).length;
    document.getElementById("recv-progress-fill").style.width = Math.round((got / total) * 100) + "%";
    document.getElementById("recv-status").textContent = "Recibidos " + got + " de " + total + " códigos...";
    vibrate();

    if (got >= total) {
      finishReceive();
    }
  }

  function finishReceive() {
    stopRecv();
    var ordered = [];
    for (var i = 0; i < recvTotal; i++) {
      if (recvChunks[i] === undefined) {
        toast("Faltó un código, probá de nuevo");
        resetRecvState();
        return;
      }
      ordered.push(recvChunks[i]);
    }
    var json = ordered.join("");
    var payload;
    try { payload = JSON.parse(json); } catch (e) {
      toast("No se pudo leer la información recibida");
      resetRecvState();
      return;
    }
    if (!payload || payload.t !== "deposito-transfer" || !Array.isArray(payload.items)) {
      toast("El código recibido no es de esta app");
      resetRecvState();
      return;
    }

    var incoming = payload.items.map(function (arr) {
      return { barcode: arr[0], name: arr[1], sector: arr[2], quantity: arr[3] || 0, expiry: arr[4] || null, locSector: arr[5] || null, locAltura: arr[6] || null };
    });
    var nuevos = incoming.filter(function (p) { return !products[p.barcode]; }).length;
    var existentes = incoming.length - nuevos;

    var summary = document.getElementById("recv-summary");
    summary.style.display = "block";
    summary.innerHTML =
      "<div>Se recibieron <b>" + incoming.length + "</b> productos (<b>" + nuevos + "</b> nuevos, <b>" + existentes + "</b> ya existentes).</div>" +
      "<div class=\"recv-actions\">" +
        "<button class=\"btn-ghost\" id=\"recv-merge\">Fusionar</button>" +
        "<button class=\"btn-primary\" id=\"recv-replace\">Reemplazar todo</button>" +
      "</div>";

    document.getElementById("recv-merge").addEventListener("click", function () {
      applyIncoming(incoming, "merge");
    });
    document.getElementById("recv-replace").addEventListener("click", function () {
      if (confirm("Esto va a borrar todo lo que tenés registrado acá y lo va a reemplazar por lo recibido. ¿Continuar?")) {
        applyIncoming(incoming, "replace");
      }
    });
  }

  function applyIncoming(incoming, mode) {
    if (mode === "replace") {
      products = {};
    }
    incoming.forEach(function (p) {
      products[p.barcode] = Object.assign({}, products[p.barcode], p, { updatedAt: Date.now() });
      if (db) {
        db.doc("products/" + sanitizeId(p.barcode)).set(products[p.barcode]).catch(function (e) {
          console.error("db set failed (import)", e);
        });
      }
    });
    saveLocal();
    render();
    toast("Información recibida y aplicada");
    document.getElementById("share-modal-backdrop").classList.remove("active");
    resetRecvState();
  }

  function startRecv() {
    if (typeof Html5Qrcode === "undefined") {
      toast("No se pudo cargar el lector de cámara.");
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast("Este navegador no permite acceso a la cámara acá. Abrí el enlace publicado directamente.");
      return;
    }
    resetRecvState();
    recvActive = true;
    document.getElementById("recv-start").style.display = "none";
    document.getElementById("recv-stop").style.display = "inline-block";
    document.getElementById("recv-status").textContent = "Solicitando permiso de cámara...";

    recvQr = new Html5Qrcode("recv-reader", { verbose: false });
    var config = { fps: 12, qrbox: { width: 260, height: 260 } };
    recvQr.start({ facingMode: "environment" }, config, onRecvChunk, function () {}).then(function () {
      document.getElementById("recv-status").textContent = "Apuntá al código que se muestra en el otro dispositivo";
    }).catch(function (err) {
      console.error(err);
      toast(cameraErrorMessage(err));
      stopRecv();
    });
  }

  function stopRecv() {
    recvActive = false;
    document.getElementById("recv-start").style.display = "inline-block";
    document.getElementById("recv-stop").style.display = "none";
    if (recvQr) {
      recvQr.stop().then(function () { recvQr.clear(); recvQr = null; }).catch(function () { recvQr = null; });
    }
  }

  document.getElementById("recv-start").addEventListener("click", startRecv);
  document.getElementById("recv-stop").addEventListener("click", function () {
    stopRecv();
    resetRecvState();
  });

  function switchShareTab(pane) {
    document.querySelectorAll(".share-tab").forEach(function (t) {
      t.classList.toggle("active", t.getAttribute("data-pane") === pane);
    });
    document.getElementById("pane-send").classList.toggle("active", pane === "send");
    document.getElementById("pane-recv").classList.toggle("active", pane === "recv");
    if (pane === "send") {
      stopRecv();
      startQrSlideshow();
    } else {
      stopQrSlideshow();
    }
  }
  document.getElementById("tab-send").addEventListener("click", function () { switchShareTab("send"); });
  document.getElementById("tab-recv").addEventListener("click", function () { switchShareTab("recv"); });

  document.getElementById("btn-share").addEventListener("click", function () {
    if (scanning) stopScan();
    document.getElementById("share-modal-backdrop").classList.add("active");
    switchShareTab("send");
  });
  function closeShareModal() {
    document.getElementById("share-modal-backdrop").classList.remove("active");
    stopQrSlideshow();
    stopRecv();
    resetRecvState();
  }
  document.getElementById("share-close").addEventListener("click", closeShareModal);
  document.getElementById("share-modal-backdrop").addEventListener("click", function (e) {
    if (e.target === this) closeShareModal();
  });

  // ---------- splash ----------
  function hideSplash() {
    var el = document.getElementById("splash");
    var elapsed = Date.now() - splashShownAt;
    var minDelay = Math.max(0, 650 - elapsed);
    setTimeout(function () {
      el.classList.add("hide");
      setTimeout(function () { el.remove(); }, 450);
    }, minDelay);
  }

  // ---------- init ----------
  loadAlertDays();
  loadLocal();
  render();
  initDb();
  initLogo();
  if (document.readyState === "complete") {
    hideSplash();
  } else {
    window.addEventListener("load", hideSplash);
  }
  setTimeout(hideSplash, 2500); // safety net so splash never gets stuck
})();
