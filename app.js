// Pap's Supply Co. — rendering, filtering, search.
// Reads the PRODUCTS array from data/products.js (generated; may also be
// prerendered into index.html for crawlers — this script re-renders live).

(function () {
  "use strict";

  // B-26: instrumentation hooks. transport is a no-op until an analytics
  // beacon token is configured (set window.PAPS_BEACON before this script
  // or assign PAPS_ANALYTICS.transport at runtime).
  window.PAPS_ANALYTICS = {
    transport: null,
    track: function (name, data) {
      if (typeof this.transport === "function") {
        try { this.transport(name, data || {}); } catch (e) { /* never break the shop */ }
      }
    }
  };

  var STICKER_SIZE_NOTE = '2" · 3" · 4" die-cut vinyl';
  var PAGE_SIZE = 24;

  // B-19: collection themes matched against title + note + slug.
  var THEMES = {
    christmas: ["christmas", "creepmas", "krampus", "yule", "noel", "nutcracker",
      "stocking", "gingerbread", "ornament", "santa", "holiday", "hanukkah", "winter"],
    coffee: ["coffee", "roast", "espresso", "decaf", "caffeine", "cocoa", "latte", "brew"],
    mushroom: ["mushroom", "fungi", "spore"],
    witch: ["witch", "hexmas", "seance", "séance"],
    horoscope: ["horoscope", "constellation"]
  };

  var activeFilter = "all";
  var activeTheme = "all";
  var searchTerm = "";
  var shownCount = PAGE_SIZE;

  var grid = document.getElementById("product-grid");
  var emptyState = document.getElementById("empty-state");
  var catalogStatus = document.getElementById("catalog-status");
  var resultCount = document.getElementById("result-count");
  var showMoreBtn = document.getElementById("show-more");
  var searchInput = document.getElementById("search");
  var featuredSection = document.getElementById("featured");
  var featuredStrip = document.getElementById("featured-strip");
  var tabs = Array.prototype.slice.call(document.querySelectorAll(".tab"));
  var chips = Array.prototype.slice.call(document.querySelectorAll(".chip"));
  var navFilterLinks = Array.prototype.slice.call(
    document.querySelectorAll(".site-nav a[data-filter]")
  );

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  // B-39: never let a bad/missing catalog blank the page.
  var catalog = (typeof PRODUCTS !== "undefined" && Array.isArray(PRODUCTS)) ? PRODUCTS : null;

  function formatPrice(value) {
    var n = Number(value);
    if (!isFinite(n)) n = 0;
    return "$" + n.toFixed(2);
  }

  function pageUrlFor(product) {
    return "products/" + product.slug + ".html";
  }

  function pinSaveUrl(product) {
    var desc = product.title + (product.note ? " — " + product.note : "");
    return "https://www.pinterest.com/pin/create/button/?url=" +
      encodeURIComponent("https://papssupplyco.com/" + pageUrlFor(product)) +
      "&media=" + encodeURIComponent(product.image || "") +
      "&description=" + encodeURIComponent(desc);
  }

  function placeholderFor(product) {
    var ph = document.createElement("div");
    ph.className = "card-media card-placeholder";
    var initial = document.createElement("span");
    initial.className = "placeholder-initial";
    initial.textContent = (product.title || "?").charAt(0).toUpperCase();
    ph.appendChild(initial);
    return ph;
  }

  function cardFor(product, placement) {
    var card = document.createElement("article");
    card.className = "product-card";
    card.dataset.category = product.category;

    var media = document.createElement("a");
    media.className = "card-media";
    media.href = pageUrlFor(product);
    if (product.image) {
      var img = document.createElement("img");
      img.src = product.image;
      img.alt = product.title;
      img.loading = "lazy";
      img.decoding = "async";
      img.width = 600;
      img.height = 600;
      (function (m, p) {
        img.addEventListener("error", function () {
          m.replaceWith(placeholderFor(p));
        });
      })(media, product);
      media.appendChild(img);
    } else {
      media = placeholderFor(product);
    }

    var body = document.createElement("div");
    body.className = "card-body";

    var title = document.createElement("h3");
    title.className = "card-title";
    var titleLink = document.createElement("a");
    titleLink.href = pageUrlFor(product);
    titleLink.textContent = product.title;
    title.appendChild(titleLink);

    var note = document.createElement("p");
    note.className = "card-note";
    note.textContent = product.note || "";

    var price = document.createElement("p");
    price.className = "card-price";
    price.textContent = formatPrice(product.price);

    body.appendChild(title);
    body.appendChild(note);
    body.appendChild(price);

    if (product.category === "stickers") {
      var size = document.createElement("p");
      size.className = "card-size";
      size.textContent = STICKER_SIZE_NOTE;
      body.appendChild(size);
    }

    var save = document.createElement("p");
    save.className = "card-save";
    var saveLink = document.createElement("a");
    saveLink.href = pinSaveUrl(product);
    saveLink.target = "_blank";
    saveLink.rel = "noopener";
    saveLink.textContent = "Save on Pinterest";
    save.appendChild(saveLink);
    body.appendChild(save);

    var buy = document.createElement("a");
    buy.className = "btn btn-gold";
    buy.href = product.buyUrl;
    buy.target = "_blank";
    buy.rel = "noopener";
    buy.textContent = "Buy Now";
    buy.setAttribute("aria-label",
      "Buy Now — " + product.title + ", " + formatPrice(product.price));
    buy.addEventListener("click", function () {
      window.PAPS_ANALYTICS.track("buy_click", {
        id: product.id, placement: placement || "catalog"
      });
    });

    card.appendChild(media);
    card.appendChild(body);
    card.appendChild(buy);

    return card;
  }

  function featuredCardFor(product, isFirst) {
    var wrap = document.createElement("div");
    wrap.className = "featured-card";
    var a = document.createElement("a");
    a.href = pageUrlFor(product);
    if (product.image) {
      var img = document.createElement("img");
      img.src = product.image;
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.width = 280;
      img.height = 280;
      if (isFirst) img.fetchPriority = "high";
      a.appendChild(img);
    }
    var t = document.createElement("span");
    t.className = "featured-card-title";
    t.textContent = product.title;
    var p = document.createElement("span");
    p.className = "featured-card-price";
    p.textContent = formatPrice(product.price);
    a.appendChild(t);
    a.appendChild(p);
    wrap.appendChild(a);
    return wrap;
  }

  function searchTextFor(product) {
    return (product.title + " " + (product.note || "") + " " +
      String(product.slug || "").replace(/-/g, " ") + " " + product.category
    ).toLowerCase();
  }

  function singular(word) {
    return word.length > 3 && word.charAt(word.length - 1) === "s"
      ? word.slice(0, -1) : word;
  }

  function matchesSearch(product) {
    if (searchTerm === "") return true;
    var text = searchTextFor(product);
    return searchTerm.split(/\s+/).every(function (word) {
      return text.indexOf(word) !== -1 || text.indexOf(singular(word)) !== -1;
    });
  }

  function matchesTheme(product) {
    if (activeTheme === "all") return true;
    var keys = THEMES[activeTheme] || [];
    var text = searchTextFor(product);
    return keys.some(function (k) { return text.indexOf(k) !== -1; });
  }

  function visibleProducts() {
    if (!catalog) return [];
    return catalog.filter(function (product) {
      var matchesCategory =
        activeFilter === "all" || product.category === activeFilter;
      return matchesCategory && matchesTheme(product) && matchesSearch(product);
    });
  }

  function countLabel(n) {
    if (activeFilter !== "all") {
      var label = activeFilter === "drinkware" ? "drinkware pieces"
        : activeFilter.charAt(0).toUpperCase() + activeFilter.slice(1);
      return n + " " + label.toLowerCase();
    }
    return n + (n === 1 ? " good" : " goods");
  }

  function renderCatalog() {
    if (!catalog) return;
    var products = visibleProducts();
    var frag = document.createDocumentFragment();
    products.slice(0, shownCount).forEach(function (product) {
      frag.appendChild(cardFor(product, "catalog"));
    });
    grid.innerHTML = "";
    grid.appendChild(frag);

    resultCount.textContent = products.length
      ? countLabel(products.length) +
        (products.length > shownCount ? " — showing " + shownCount : "")
      : "";
    emptyState.hidden = products.length > 0;
    if (products.length === 0) {
      window.PAPS_ANALYTICS.track("search_zero_result", {
        q: searchTerm, filter: activeFilter, theme: activeTheme
      });
    }
    showMoreBtn.hidden = products.length <= shownCount;
  }

  function renderFeatured() {
    if (!catalog) return;
    var featured = catalog.filter(function (p) { return p.featured; });
    featuredStrip.innerHTML = "";
    if (!featured.length) {
      featuredSection.hidden = true;
      return;
    }
    featuredSection.hidden = false;
    var frag = document.createDocumentFragment();
    featured.forEach(function (product, i) {
      frag.appendChild(featuredCardFor(product, i === 0));
    });
    featuredStrip.appendChild(frag);
  }

  // B-40: filter/search state lives in the URL hash so views are linkable.
  function syncHash() {
    var parts = [];
    if (activeFilter !== "all") parts.push("filter=" + activeFilter);
    if (activeTheme !== "all") parts.push("theme=" + activeTheme);
    if (searchTerm !== "") parts.push("q=" + encodeURIComponent(searchTerm));
    var hash = parts.length ? "#" + parts.join("&") : "#catalog";
    if (window.location.hash !== hash) {
      history.replaceState(null, "", hash);
    }
  }

  function applyHash() {
    var hash = window.location.hash.replace(/^#/, "");
    var params = {};
    hash.split("&").forEach(function (pair) {
      var kv = pair.split("=");
      if (kv.length === 2) params[kv[0]] = decodeURIComponent(kv[1]);
    });
    if (params.filter && ["all", "stickers", "drinkware", "candles", "apparel"]
        .indexOf(params.filter) !== -1) {
      activeFilter = params.filter;
    }
    if (params.theme && (params.theme === "all" || THEMES[params.theme])) {
      activeTheme = params.theme;
    }
    if (typeof params.q === "string") {
      searchTerm = params.q.trim().toLowerCase();
      searchInput.value = params.q;
    }
    paintControls();
    shownCount = PAGE_SIZE;
    renderCatalog();
  }

  function paintControls() {
    tabs.forEach(function (tab) {
      var isActive = tab.dataset.filter === activeFilter;
      tab.classList.toggle("active", isActive);
      tab.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
    chips.forEach(function (chip) {
      var isActive = chip.dataset.theme === activeTheme;
      chip.classList.toggle("active", isActive);
      chip.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
  }

  function setFilter(filter) {
    activeFilter = filter;
    shownCount = PAGE_SIZE;
    paintControls();
    renderCatalog();
    syncHash();
  }

  function setTheme(theme) {
    activeTheme = theme;
    shownCount = PAGE_SIZE;
    paintControls();
    renderCatalog();
    syncHash();
  }

  tabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      setFilter(tab.dataset.filter);
    });
  });

  chips.forEach(function (chip) {
    chip.addEventListener("click", function () {
      setTheme(chip.dataset.theme);
    });
  });

  navFilterLinks.forEach(function (link) {
    link.addEventListener("click", function () {
      setFilter(link.dataset.filter);
    });
  });

  showMoreBtn.addEventListener("click", function () {
    shownCount += PAGE_SIZE;
    renderCatalog();
  });

  // "Back to top" / wordmark: scroll explicitly to 0. A plain #top anchor
  // on the sticky header lands short of the page top in some browsers.
  Array.prototype.slice
    .call(document.querySelectorAll('a[href="#top"]'))
    .forEach(function (link) {
      link.addEventListener("click", function (event) {
        event.preventDefault();
        window.scrollTo({
          top: 0,
          behavior: reduceMotion.matches ? "auto" : "smooth"
        });
      });
    });

  // B-37: debounce search ~150ms.
  var searchTimer = null;
  searchInput.addEventListener("input", function () {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(function () {
      searchTerm = searchInput.value.trim().toLowerCase();
      if (searchTerm !== "" && activeFilter !== "all") {
        activeFilter = "all"; // search covers the whole catalog
      }
      shownCount = PAGE_SIZE;
      paintControls();
      renderCatalog();
      syncHash();
    }, 150);
  });

  window.addEventListener("hashchange", function () {
    if (window.location.hash.indexOf("filter=") !== -1 ||
        window.location.hash.indexOf("theme=") !== -1 ||
        window.location.hash.indexOf("q=") !== -1) {
      applyHash();
    }
  });

  // Site text comes from data/config.js (generated from site-config.json,
  // the one editable source). The HTML copy stays as the fallback.
  if (typeof SITE_CONFIG !== "undefined") {
    if (SITE_CONFIG.pageTitle) document.title = SITE_CONFIG.pageTitle;
    var heroTitle = document.querySelector(".hero-title");
    if (heroTitle && SITE_CONFIG.heroTitle) {
      heroTitle.textContent = SITE_CONFIG.heroTitle;
    }
    var heroSub = document.querySelector(".hero-sub");
    if (heroSub && SITE_CONFIG.heroSub) {
      heroSub.textContent = SITE_CONFIG.heroSub;
    }
    var aboutHeading = document.querySelector(".about .section-title");
    if (aboutHeading && SITE_CONFIG.aboutHeading) {
      aboutHeading.textContent = SITE_CONFIG.aboutHeading;
    }
    var aboutText = document.querySelector(".about-text");
    if (aboutText && SITE_CONFIG.aboutText) {
      aboutText.textContent = SITE_CONFIG.aboutText;
    }
    // B-43: wire the Kit forms once a real form action is configured.
    if (SITE_CONFIG.kitOfferText) {
      Array.prototype.slice.call(document.querySelectorAll(".kit-offer"))
        .forEach(function (el) { el.textContent = SITE_CONFIG.kitOfferText; });
    }
    var kitAction = SITE_CONFIG.kitFormAction;
    Array.prototype.slice.call(document.querySelectorAll(".kit-form"))
      .forEach(function (form) {
        if (kitAction) {
          form.setAttribute("action", kitAction);
        } else {
          form.addEventListener("submit", function (event) {
            event.preventDefault();
            window.PAPS_ANALYTICS.track("kit_signup_intent", {});
            var note = form.querySelector(".kit-note");
            if (!note) {
              note = document.createElement("p");
              note.className = "kit-note";
              form.appendChild(note);
            }
            note.textContent = "The haunt list opens soon — follow along on Instagram for the launch.";
          });
        }
      });
  }

  if (!catalog) {
    // B-39: a failed catalog load must not look like an empty shop.
    grid.innerHTML = "";
    emptyState.hidden = true;
    if (catalogStatus) {
      catalogStatus.hidden = false;
      catalogStatus.innerHTML =
        'The catalog is reloading — the full shop is open at ' +
        '<a href="https://shop.papssupplyco.com">shop.papssupplyco.com</a>.';
    }
    if (featuredSection) featuredSection.hidden = true;
    if (resultCount) resultCount.textContent = "";
  } else if (catalog.length === 0) {
    if (catalogStatus) {
      catalogStatus.hidden = false;
      catalogStatus.innerHTML =
        'The catalog is reloading — the full shop is open at ' +
        '<a href="https://shop.papssupplyco.com">shop.papssupplyco.com</a>.';
    }
    if (featuredSection) featuredSection.hidden = true;
  } else {
    renderFeatured();
    if (window.location.hash.indexOf("filter=") !== -1 ||
        window.location.hash.indexOf("theme=") !== -1 ||
        window.location.hash.indexOf("q=") !== -1) {
      applyHash();
    } else {
      renderCatalog();
    }
  }
})();

