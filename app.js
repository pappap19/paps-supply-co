// Pap's Supply Co. — rendering, filtering, search.
// Reads the PRODUCTS array from data/products.js.

(function () {
  "use strict";

  var STICKER_SIZE_NOTE = '2" · 3" · 4" die-cut vinyl';

  var activeFilter = "all";
  var searchTerm = "";

  var grid = document.getElementById("product-grid");
  var emptyState = document.getElementById("empty-state");
  var searchInput = document.getElementById("search");
  var featuredStrip = document.getElementById("featured-strip");
  var tabs = Array.prototype.slice.call(document.querySelectorAll(".tab"));
  var navFilterLinks = Array.prototype.slice.call(
    document.querySelectorAll(".site-nav a[data-filter]")
  );

  var revealObserver = null;
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  if ("IntersectionObserver" in window && !reduceMotion.matches) {
    revealObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("visible");
            revealObserver.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.1 }
    );
  }

  function observeReveal(el) {
    if (revealObserver) {
      revealObserver.observe(el);
    } else {
      el.classList.add("visible");
    }
  }

  function formatPrice(value) {
    return "$" + value.toFixed(2);
  }

  function placeholderFor(product) {
    var ph = document.createElement("div");
    ph.className = "card-media card-placeholder";
    var initial = document.createElement("span");
    initial.className = "placeholder-initial";
    initial.textContent = product.title.charAt(0).toUpperCase();
    ph.appendChild(initial);
    return ph;
  }

  function cardFor(product) {
    var card = document.createElement("article");
    card.className = "product-card reveal";
    card.dataset.category = product.category;

    var media = document.createElement("div");
    media.className = "card-media";
    var img = document.createElement("img");
    img.src = product.image;
    img.alt = product.title;
    img.loading = "lazy";
    img.addEventListener("error", function () {
      media.replaceWith(placeholderFor(product));
    });
    media.appendChild(img);

    var body = document.createElement("div");
    body.className = "card-body";

    var title = document.createElement("h3");
    title.className = "card-title";
    title.textContent = product.title;

    var note = document.createElement("p");
    note.className = "card-note";
    note.textContent = product.note;

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

    var buy = document.createElement("a");
    buy.className = "btn btn-gold";
    buy.href = product.buyUrl;
    buy.target = "_blank";
    buy.rel = "noopener";
    buy.textContent = "Buy on Printify";

    card.appendChild(media);
    card.appendChild(body);
    card.appendChild(buy);

    return card;
  }

  function visibleProducts() {
    return PRODUCTS.filter(function (product) {
      var matchesCategory =
        activeFilter === "all" || product.category === activeFilter;
      var matchesSearch =
        searchTerm === "" ||
        product.title.toLowerCase().indexOf(searchTerm) !== -1;
      return matchesCategory && matchesSearch;
    });
  }

  function renderCatalog() {
    grid.innerHTML = "";
    var products = visibleProducts();

    products.forEach(function (product) {
      var card = cardFor(product);
      grid.appendChild(card);
      observeReveal(card);
    });

    emptyState.hidden = products.length > 0;
  }

  function renderFeatured() {
    featuredStrip.innerHTML = "";
    PRODUCTS.filter(function (product) {
      return product.featured;
    }).forEach(function (product) {
      var card = cardFor(product);
      featuredStrip.appendChild(card);
      observeReveal(card);
    });
  }

  function setFilter(filter) {
    activeFilter = filter;
    tabs.forEach(function (tab) {
      var isActive = tab.dataset.filter === filter;
      tab.classList.toggle("active", isActive);
      tab.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
    renderCatalog();
  }

  tabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      setFilter(tab.dataset.filter);
    });
  });

  navFilterLinks.forEach(function (link) {
    link.addEventListener("click", function () {
      setFilter(link.dataset.filter);
    });
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

  searchInput.addEventListener("input", function () {
    searchTerm = searchInput.value.trim().toLowerCase();
    if (searchTerm !== "" && activeFilter !== "all") {
      // Search always covers the whole catalog: typing a search resets
      // the category filter so a product in another category still shows.
      setFilter("all");
      return;
    }
    renderCatalog();
  });

  renderFeatured();
  renderCatalog();
  document
    .querySelectorAll("section.reveal")
    .forEach(function (section) {
      observeReveal(section);
    });
})();
