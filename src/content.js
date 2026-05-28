(() => {
  "use strict";

  const ROOT_ID = "hangar-helper-toolbar";
  const ANTI_FLASH_CLASS = "hangar-helper-pledges-booting";
  const LOADING_ID = "hangar-helper-loading";
  const STYLE_MARKER = "data-hangar-helper";
  const SUMMARY_SELECTOR = "[data-hh-summary-card]";
  const CARD_SELECTOR = "li";
  const CHECK_FOR_UPDATES_INTERVAL_MS = 60 * 1000;
  const CACHE_DB_NAME = "hangar-helper-cache";
  const CACHE_DB_VERSION = 1;
  const CACHE_STORE_NAME = "entries";
  const FETCH_CONCURRENCY = 6;
  const PAGE_CACHE_PREFIX = "hangar-helper:pledge-page:";
  const PLEDGE_AGGREGATE_CACHE_KEY = `${PAGE_CACHE_PREFIX}aggregate`;
  const PLEDGE_AGGREGATE_CACHE_VERSION = 2;
  const PAGE_SIZES = [10, 25, 50, 100];
  const SESSION_ID_KEY = "hangar-helper:session-id";

  let currentCards = [];
  let currentFilteredGroups = [];
  let currentGroups = [];
  let currentTotalCards = 0;
  let currentPage = 1;
  let currentCategoryFilter = "all";
  let currentGiftableFilter = null;
  let currentMeltableFilter = null;
  let currentSearchTerm = "";
  let isAggregated = false;
  let pageSize = 25;
  let pledgeListParent;
  let refreshIntervalId;
  let refreshInProgress = false;
  let observer;
  const pledgeCardMetadata = new WeakMap();
  let renderQueued = false;

  installAntiFlashStyle();

  function installAntiFlashStyle() {
    if (isBuyBackPage()) {
      return;
    }

    document.documentElement.classList.add(ANTI_FLASH_CLASS);
  }

  function clearAntiFlashStyle() {
    document.documentElement.classList.remove(ANTI_FLASH_CLASS);
  }

  function queueRender() {
    if (renderQueued) {
      return;
    }

    renderQueued = true;
    window.setTimeout(() => {
      renderQueued = false;
      render();
    }, 150);
  }

  async function render() {
    observer?.disconnect();

    removeOrphanSummaries();

    const cards = findPledgeCards();
    pledgeListParent = cards[0]?.parentElement ?? pledgeListParent;

    if (cards.length === 0) {
      if (document.body) {
        ensureToolbar(0);
      }
      startObserver();
      return;
    }

    setLoadingState(true, "Loading pledge pages...");
    ensureToolbar(cards.length, cards.length);
    setToolbarLoading(cards.length, "Loading pledge pages...");

    const cachedAggregateCards = await getCachedPledgeAggregate();
    if (cachedAggregateCards.length > 0) {
      removeLivePledgeCards(cards);
      currentCards = cachedAggregateCards;
      isAggregated = true;
      rebuildView();
      setLoadingState(false);
      startBackgroundRefresh();
      return;
    }

    setCachedPledgePage(window.location.href, document.documentElement.outerHTML);

    const aggregateCards = await loadAllPledgeCards(cards);

    currentCards = dedupeCards(aggregateCards);
    isAggregated = true;
    await setCachedPledgeAggregate(currentCards);

    rebuildView();
    setLoadingState(false);
    startBackgroundRefresh();
  }

  function rebuildView() {
    hideRsiPagers();
    hidePledgeSpacer();

    currentGroups = getCardGroups(currentCards);
    currentFilteredGroups = getFilteredGroups();
    currentTotalCards = currentCards.length;
    currentPage = Math.min(currentPage, getTotalPages(currentFilteredGroups.length));

    ensureToolbar(currentFilteredGroups.length, currentTotalCards);
    enhanceGroups(currentGroups);
    applyLocalPageSize(currentFilteredGroups);
    updateLocalPagers();
  }

  function findPledgeCards() {
    return Array.from(document.querySelectorAll(CARD_SELECTOR))
      .filter((element) => !element.closest(`#${ROOT_ID}`))
      .filter((element) => !element.matches(SUMMARY_SELECTOR))
      .filter(isLikelyPledgeCard)
      .filter((element, index, all) => !all.some((other, otherIndex) => {
        return otherIndex !== index && element.contains(other);
      }));
  }

  function isLikelyPledgeCard(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    if (element.getAttribute(STYLE_MARKER) === "card") {
      return true;
    }

    return Boolean(
      element.querySelector(":scope > .row .basic-infos")
      && element.querySelector(":scope > .row .js-expand-arrow")
      && element.querySelector(":scope > .row .js-pledge-name")
    );
  }

  function findHeadline(card) {
    const candidates = Array.from(card.querySelectorAll("h1, h2, h3, h4, h5, .title, .name, [class*='title'], [class*='name'], strong"))
      .filter((element) => element.textContent.trim().length > 0);

    return candidates[0] ?? null;
  }

  function getCardGroups(cards) {
    const groupsByKey = new Map();

    cards.forEach((card) => {
      const metadata = getPledgeCardMetadata(card);
      const title = metadata.displayTitle;
      const key = metadata.groupKey;
      const createdAt = new Date(metadata.createdAt);
      const groupCreatedAt = Number.isNaN(createdAt.getTime()) ? new Date(0) : createdAt;

      if (!groupsByKey.has(key)) {
        groupsByKey.set(key, {
          cards: [],
          createdAt: groupCreatedAt,
          key,
          title
        });
      }

      groupsByKey.get(key).cards.push(card);
    });

    return Array.from(groupsByKey.values())
      .sort((left, right) => {
        const dateComparison = right.createdAt.getTime() - left.createdAt.getTime();
        return dateComparison || left.title.localeCompare(right.title);
      });
  }

  function applyCurrentFilters() {
    currentFilteredGroups = getFilteredGroups();
    currentPage = Math.min(currentPage, getTotalPages(currentFilteredGroups.length));
    applyLocalPageSize(currentFilteredGroups);
    updateLocalPagers();
    updateStatus(document.getElementById(ROOT_ID), currentFilteredGroups.length, getFilteredPledgeCount(), currentTotalCards);
  }

  function getFilteredPledgeCount() {
    return currentFilteredGroups.reduce((total, group) => total + group.cards.length, 0);
  }

  function getFilteredGroups() {
    if (isBuyBackPage()) {
      return getFilteredBuyBackGroups();
    }

    const searchTerm = currentSearchTerm.trim().toLocaleLowerCase();

    return currentGroups.filter((group) => {
      const categoryMatches = currentCategoryFilter === "all"
        || group.cards.some((card) => pledgeMetadataMatchesCategory(getPledgeCardMetadata(card), currentCategoryFilter));
      const meltableMatches = matchesPledgeMetadataTriStateFilter(group, "isMeltable", currentMeltableFilter);
      const giftableMatches = matchesPledgeMetadataTriStateFilter(group, "isGiftable", currentGiftableFilter);
      const searchMatches = !searchTerm
        || group.title.toLocaleLowerCase().includes(searchTerm)
        || group.cards.some((card) => getPledgeCardMetadata(card).searchableText.includes(searchTerm));

      return categoryMatches && meltableMatches && giftableMatches && searchMatches;
    });
  }

  function getFilteredBuyBackGroups() {
    const searchTerm = currentSearchTerm.trim().toLocaleLowerCase();

    return currentGroups.filter((group) => {
      const categoryMatches = currentCategoryFilter === "all"
        || group.cards.some((card) => cardMatchesCategory(card, currentCategoryFilter));
      const meltableMatches = matchesTriStateFilter(group, isMeltable, currentMeltableFilter);
      const giftableMatches = matchesTriStateFilter(group, isGiftable, currentGiftableFilter);
      const searchMatches = !searchTerm
        || group.title.toLocaleLowerCase().includes(searchTerm)
        || group.cards.some((card) => getSearchableText(card).includes(searchTerm));

      return categoryMatches && meltableMatches && giftableMatches && searchMatches;
    });
  }

  function matchesPledgeMetadataTriStateFilter(group, property, filterValue) {
    if (filterValue === null) {
      return true;
    }

    return group.cards.some((card) => getPledgeCardMetadata(card)[property] === filterValue);
  }

  function pledgeMetadataMatchesCategory(metadata, category) {
    if (category === "game-package") {
      return metadata.hasStarCitizenDigitalDownload;
    }

    if (category === "ships") {
      return metadata.hasShip;
    }

    if (category === "upgrades") {
      return metadata.hasApplyUpgradeButton;
    }

    if (category === "skins") {
      return metadata.hasSkin;
    }

    if (category === "items") {
      return metadata.category === "items";
    }

    return true;
  }

  function cardMatchesCategory(card, category) {
    if (isBuyBackPage()) {
      return buyBackMatchesCategory(card, category);
    }

    if (category === "game-package") {
      return hasStarCitizenDigitalDownload(card);
    }

    if (category === "ships") {
      return getShipItems(card).length > 0;
    }

    if (category === "upgrades") {
      return hasApplyUpgradeButton(card);
    }

    if (category === "skins") {
      return hasItemKind(card, "skin");
    }

    if (category === "items") {
      return getCardCategory(card) === "items";
    }

    return true;
  }

  function buyBackMatchesCategory(card, category) {
    const title = getBuyBackTitle(card).toLocaleLowerCase();
    const contained = getBuyBackContainedText(card).toLocaleLowerCase();
    const text = `${title} ${contained}`;

    if (category === "game-package") {
      return /^package\b/.test(title) || text.includes("star citizen");
    }

    if (category === "ships") {
      return /^standalone ships?\b/.test(title) || /\band\s+\d+\s+items?\b/.test(contained);
    }

    if (category === "upgrades") {
      return /^upgrade\b/.test(title) || Boolean(card.querySelector(".js-open-ship-upgrades"));
    }

    if (category === "skins") {
      return /^paints?\b/.test(title) || /\bpaint\b/.test(text) || /\bskin\b/.test(text);
    }

    if (category === "items") {
      return !buyBackMatchesCategory(card, "game-package")
        && !buyBackMatchesCategory(card, "ships")
        && !buyBackMatchesCategory(card, "upgrades")
        && !buyBackMatchesCategory(card, "skins");
    }

    return true;
  }

  function getCardCategory(card) {
    if (hasStarCitizenDigitalDownload(card)) {
      return "game-package";
    }

    if (hasApplyUpgradeButton(card)) {
      return "upgrades";
    }

    if (hasItemKind(card, "skin")) {
      return "skins";
    }

    if (getShipItems(card).length > 0) {
      return "ships";
    }

    return "items";
  }

  function getSearchableText(card) {
    if (isBuyBackPage()) {
      return normalizeTitle(card.textContent ?? "").toLocaleLowerCase();
    }

    return getPledgeCardMetadata(card).searchableText;
  }

  function getPledgeCardMetadata(card) {
    const cached = pledgeCardMetadata.get(card);
    if (cached) {
      return cached;
    }

    const metadata = classifyPledgeCard(card);
    pledgeCardMetadata.set(card, metadata);
    return metadata;
  }

  function classifyPledgeCard(card) {
    const title = getPledgeTitle(card);
    const displayTitle = getDisplayPledgeTitle(card);
    const createdAt = getCreatedAt(card);
    const shipItems = getShipItems(card);
    const itemNames = getItemNames(card);
    const hasStarCitizenDownload = itemNames.join(" ").toLocaleLowerCase().includes("star citizen digital download");
    const hasUpgradeButton = hasApplyUpgradeButton(card);
    const hasSkin = hasItemKind(card, "skin");

    return {
      version: PLEDGE_AGGREGATE_CACHE_VERSION,
      category: getPledgeCategoryFromFlags({
        hasApplyUpgradeButton: hasUpgradeButton,
        hasShip: shipItems.length > 0,
        hasSkin,
        hasStarCitizenDigitalDownload: hasStarCitizenDownload
      }),
      createdAt: createdAt.toISOString(),
      displayTitle,
      groupKey: displayTitle.toLocaleLowerCase(),
      hasApplyUpgradeButton: hasUpgradeButton,
      hasShip: shipItems.length > 0,
      hasSkin,
      hasStarCitizenDigitalDownload: hasStarCitizenDownload,
      id: getPledgeId(card),
      isGiftable: isGiftable(card),
      isMeltable: isMeltable(card),
      itemNames,
      meltValue: getMeltValue(card),
      searchableText: [
        title,
        displayTitle,
        normalizeTitle(card.textContent ?? ""),
        itemNames.join(" ")
      ].join(" ").toLocaleLowerCase(),
      title
    };
  }

  function getPledgeCategoryFromFlags(flags) {
    if (flags.hasStarCitizenDigitalDownload) {
      return "game-package";
    }

    if (flags.hasApplyUpgradeButton) {
      return "upgrades";
    }

    if (flags.hasSkin) {
      return "skins";
    }

    if (flags.hasShip) {
      return "ships";
    }

    return "items";
  }

  function hasApplyUpgradeButton(card) {
    return /apply\s+upgrade/i.test(card.textContent ?? "")
      || Boolean(card.querySelector(":scope > .row [class*='apply'][class*='upgrade'], :scope > .row [href*='upgrade']"));
  }

  function hasStarCitizenDigitalDownload(card) {
    return getItemNames(card).join(" ").toLocaleLowerCase().includes("star citizen digital download");
  }

  function isMeltable(card) {
    return /exchange/i.test(card.textContent ?? "")
      || Boolean(card.querySelector(":scope > .row .js-reclaim, :scope > .row [class*='reclaim']"));
  }

  function hasItemKind(card, kind) {
    return Array.from(card.querySelectorAll(":scope > .row .items.more.js-more .item .kind"))
      .some((kindElement) => kindElement.textContent.trim().localeCompare(kind, undefined, { sensitivity: "accent" }) === 0);
  }

  function matchesTriStateFilter(group, predicate, filterValue) {
    if (filterValue === null) {
      return true;
    }

    return group.cards.some((card) => predicate(card) === filterValue);
  }

  function ensureToolbar(totalGroups, totalCards = totalGroups) {
    const firstCard = findPledgeCards()[0];
    let toolbar = document.getElementById(ROOT_ID);

    if (!toolbar) {
      toolbar = document.createElement("section");
      toolbar.id = ROOT_ID;
      toolbar.setAttribute(STYLE_MARKER, "toolbar");
      toolbar.innerHTML = `
        <div class="hh-toolbar-row">
          <label class="hh-page-size">
            Pledges per page
            <select aria-label="Pledges per page" data-hh-page-size>
              ${PAGE_SIZES.map((size) => `<option value="${size}">${size}</option>`).join("")}
            </select>
          </label>
          <button type="button" data-hh-reload>Reload pledges</button>
          <div class="hh-local-pager" data-hh-pager="top"></div>
          <div class="hh-status" data-hh-status></div>
        </div>
        <div class="hh-toolbar-row hh-filter-row">
          <label>
            Filter
            <select aria-label="Filter pledges" data-hh-category-filter>
              <option value="all">All</option>
              <option value="game-package">Game package</option>
              <option value="ships">Ships</option>
              <option value="upgrades">Upgrades</option>
              <option value="skins">Skins</option>
              <option value="items">Items</option>
            </select>
          </label>
          <label class="hh-search">
            Search
            <input type="search" placeholder="Search pledges" data-hh-search>
          </label>
          <button type="button" data-hh-toggle-filter="meltable">Meltable</button>
          <button type="button" data-hh-toggle-filter="giftable">Giftable</button>
        </div>
      `;

      toolbar.querySelector("[data-hh-page-size]").addEventListener("change", (event) => {
        pageSize = Number(event.target.value);
        currentPage = 1;
        applyCurrentFilters();
      });

      toolbar.querySelector("[data-hh-category-filter]").addEventListener("change", (event) => {
        currentCategoryFilter = event.target.value;
        currentPage = 1;
        applyCurrentFilters();
      });

      toolbar.querySelector("[data-hh-search]").addEventListener("input", (event) => {
        currentSearchTerm = event.target.value;
        currentPage = 1;
        applyCurrentFilters();
      });

      toolbar.querySelector("[data-hh-toggle-filter='meltable']").addEventListener("click", (event) => {
        currentMeltableFilter = getNextTriState(currentMeltableFilter);
        updateTriStateButton(event.target, "Meltable", currentMeltableFilter);
        currentPage = 1;
        applyCurrentFilters();
      });

      toolbar.querySelector("[data-hh-toggle-filter='giftable']").addEventListener("click", (event) => {
        currentGiftableFilter = getNextTriState(currentGiftableFilter);
        updateTriStateButton(event.target, "Giftable", currentGiftableFilter);
        currentPage = 1;
        applyCurrentFilters();
      });

      toolbar.querySelector("[data-hh-reload]").addEventListener("click", async () => {
        await clearPledgePageCache();
        currentCards = [];
        currentFilteredGroups = [];
        currentGroups = [];
        currentTotalCards = 0;
        currentPage = 1;
        isAggregated = false;
        await render();
      });

      toolbar.querySelector("[data-hh-pager='top']").addEventListener("click", handlePagerClick);

      const target = firstCard ?? pledgeListParent ?? document.querySelector("main, #content, .content");
      if (target?.parentElement) {
        target.parentElement.insertBefore(toolbar, target);
      } else {
        document.body.prepend(toolbar);
      }
    }

    toolbar.querySelector("[data-hh-page-size]").value = String(pageSize);
    toolbar.querySelector("[data-hh-category-filter]").value = currentCategoryFilter;
    toolbar.querySelector("[data-hh-search]").value = currentSearchTerm;
    updateTriStateButton(toolbar.querySelector("[data-hh-toggle-filter='meltable']"), "Meltable", currentMeltableFilter);
    updateTriStateButton(toolbar.querySelector("[data-hh-toggle-filter='giftable']"), "Giftable", currentGiftableFilter);
    updateStatus(toolbar, totalGroups, getFilteredPledgeCount(), totalCards);
  }

  function getNextTriState(value) {
    if (value === null) {
      return true;
    }

    if (value === true) {
      return false;
    }

    return null;
  }

  function updateTriStateButton(button, label, value) {
    button.dataset.hhTriState = value === null ? "null" : String(value);
    button.textContent = label;
  }

  function updateStatus(toolbar, totalGroups, filteredCards, totalCards) {
    const diagnostic = toolbar.querySelector("[data-hh-status]");
    delete toolbar.dataset.hhLoading;
    const hasCards = totalGroups > 0;
    const start = hasCards ? ((currentPage - 1) * pageSize) + 1 : 0;
    const end = Math.min(currentPage * pageSize, totalGroups);

    diagnostic.textContent = hasCards
      ? `${start}-${end} of ${totalGroups} group${totalGroups === 1 ? "" : "s"} shown (${filteredCards} of ${totalCards} pledge${totalCards === 1 ? "" : "s"} ${isAggregated ? "loaded across pages" : "loaded"})`
      : "Hangar Helper is active on this page. No pledge items detected yet.";
  }

  function setToolbarLoading(visibleCards, message) {
    ensureToolbar(visibleCards, visibleCards);
    const toolbar = document.getElementById(ROOT_ID);
    if (toolbar) {
      toolbar.dataset.hhLoading = "true";
    }
    const diagnostic = toolbar?.querySelector("[data-hh-status]");
    if (diagnostic) {
      diagnostic.textContent = message;
    }
  }

  function setLoadingState(isLoading, message = "Loading...") {
    const parent = getLivePledgeListParent();
    if (!parent) {
      return;
    }

    parent.dataset.hhLoading = String(isLoading);

    if (isLoading) {
      let loading = document.getElementById(LOADING_ID);
      if (!loading) {
        loading = document.createElement("div");
        loading.id = LOADING_ID;
        loading.setAttribute(STYLE_MARKER, "loading");
        loading.innerHTML = `
          <div class="hh-spinner"></div>
          <div data-hh-loading-message></div>
        `;
        parent.parentElement.insertBefore(loading, parent);
      }
      loading.querySelector("[data-hh-loading-message]").textContent = message;
    } else {
      document.getElementById(LOADING_ID)?.remove();
      delete parent.dataset.hhLoading;
      clearAntiFlashStyle();
    }
  }

  function enhanceGroups(groups) {
    const parent = getLivePledgeListParent();
    let bottomPager;
    if (parent) {
      bottomPager = ensureBottomPager(parent);
    }

    groups.forEach((group) => {
      group.cards.forEach((card) => {
        card.setAttribute(STYLE_MARKER, "card");

        const header = findHeadline(card);
        if (header) {
          header.setAttribute(STYLE_MARKER, "headline");
        }

        ensurePledgeAnnotations(card);
        ensureReadOnlyDetailsToggle(card);
      });

      const summary = ensureSummaryCard(group);
      group.summary = summary;

      if (parent) {
        appendIfNeeded(parent, summary);
        group.cards.forEach((card) => appendIfNeeded(parent, card));
      }

      applyGroupState(group);
    });

    if (parent && bottomPager) {
      appendIfNeeded(parent, bottomPager);
    }
  }

  function getLivePledgeListParent() {
    return currentCards.find((card) => card.isConnected && card.parentElement)?.parentElement
      ?? pledgeListParent
      ?? findPledgeCards()[0]?.parentElement
      ?? document.querySelector("main, #content, .content, body");
  }

  function removeLivePledgeCards(cards) {
    cards.forEach((card) => {
      if (card.isConnected) {
        card.remove();
      }
    });
  }

  function ensureSummaryCard(group) {
    let summary = findExistingSummary(group.key);

    if (!summary) {
      summary = document.createElement("div");
      summary.dataset.hhSummaryCard = "true";
      summary.dataset.hhExpanded = "false";
      summary.role = "button";
      summary.tabIndex = 0;
      summary.setAttribute(STYLE_MARKER, "summary");

      const title = document.createElement("span");
      title.dataset.hhSummaryTitle = "true";

      summary.append(title);
    }

    summary.onclick = () => {
      summary.dataset.hhExpanded = summary.dataset.hhExpanded === "true" ? "false" : "true";
      applyGroupState(group);
    };
    summary.onkeydown = (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        summary.click();
      }
    };

    summary.dataset.hhGroupKey = group.key;
    summary.querySelector("[data-hh-summary-title]").textContent = group.cards.length > 1
      ? `${group.title} (${group.cards.length})`
      : group.title;

    return summary;
  }

  function findExistingSummary(groupKey) {
    return Array.from(document.querySelectorAll(SUMMARY_SELECTOR))
      .find((summary) => summary.dataset.hhGroupKey === groupKey) ?? null;
  }

  function getPledgeTitle(card, header = findHeadline(card)) {
    const pledgeNameInput = card.querySelector(":scope > .row .js-pledge-name");
    if (pledgeNameInput instanceof HTMLInputElement && pledgeNameInput.value.trim()) {
      return cleanPledgeTitle(pledgeNameInput.value);
    }

    const headlineText = cleanPledgeTitle(header?.textContent ?? "");
    if (headlineText) {
      return headlineText;
    }

    const textLines = card.textContent
      .split(/\r?\n/)
      .map(normalizeTitle)
      .filter(Boolean);

    const title = textLines.find((line) => {
      return !/^(expand|collapse|attributed|created:|contains:|page \d+|previous|next)$/i.test(line);
    }) ?? "";

    return cleanPledgeTitle(title);
  }

  function getDisplayPledgeTitle(card) {
    const shipName = getPrimaryShipName(card);
    if (!shipName) {
      return getPledgeTitle(card);
    }

    const titleParts = [
      getPledgePrefix(getPledgeTitle(card)),
      formatShipTitleSegment(card, shipName),
      ...getDigitalDownloadTitleSegments(card)
    ];

    return titleParts.join(" - ").replaceAll(" - +", " +");
  }

  function getPrimaryShipName(card) {
    return getShipItems(card)[0]?.name ?? "";
  }

  function getShipItems(card) {
    return Array.from(card.querySelectorAll(":scope > .row .items.more.js-more .item"))
      .filter((item) => /^(ship|vehicle)$/i.test(normalizeTitle(item.querySelector(".kind")?.textContent ?? "")))
      .map((item) => ({
        element: item,
        name: cleanPledgeTitle(item.querySelector(".title")?.textContent ?? "")
      }))
      .filter((item) => item.name);
  }

  function getItemNames(card) {
    return Array.from(card.querySelectorAll(":scope > .row .items.more.js-more .item .title"))
      .map((itemTitle) => cleanPledgeTitle(itemTitle.textContent ?? ""))
      .filter(Boolean);
  }

  function getPledgePrefix(title) {
    const prefix = title.split(/\s+-\s+/)[0] ?? title;
    if (/^standalone ships?$/i.test(prefix)) {
      return "Standalone Ship";
    }

    if (/^package$/i.test(prefix)) {
      return "Package";
    }

    return "Referral reward";
  }

  function formatShipTitleSegment(card, shipName) {
    return getHighestInsurance(card)?.rank === Number.MAX_SAFE_INTEGER
      ? `${shipName} LTI`
      : shipName;
  }

  function getDigitalDownloadTitleSegments(card) {
    const text = getItemNames(card).join(" ").toLocaleLowerCase();
    const segments = [];

    if (text.includes("star citizen digital download")) {
      segments.push("+ Star Citizen");
    }

    if (text.includes("squadron 42 digital download")) {
      segments.push("+ Squadron 42");
    }

    return segments;
  }

  function normalizeTitle(value) {
    return value.trim().replace(/\s+/g, " ");
  }

  function cleanPledgeTitle(value) {
    return normalizeTitle(value)
      .replace(/\[\]/g, "")
      .replace(/\bnull\b/gi, "")
      .replace(/\battributed\b/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  function getCreatedAt(card) {
    const dateColumn = card.querySelector(":scope > .row .date-col");
    const rawDate = normalizeTitle((dateColumn?.textContent ?? "").replace(/^Created:\s*/i, ""));
    const parsedDate = new Date(rawDate);

    return Number.isNaN(parsedDate.getTime()) ? new Date(0) : parsedDate;
  }

  function ensurePledgeAnnotations(card) {
    const meltValue = getMeltValue(card);
    const insurance = getHighestInsurance(card);
    const dateColumn = card.querySelector(":scope > .row .date-col");
    if (dateColumn && insurance) {
      card.dataset.hhHasInsurance = "true";
      ensureInfoLine(dateColumn, "insurance", insurance.label.toUpperCase(), {
        important: true,
        prepend: true
      });
    } else {
      delete card.dataset.hhHasInsurance;
    }

    if (dateColumn && meltValue.amount > 0) {
      ensureInfoLine(dateColumn, "melt", `Melt Value: ${meltValue.label}`);
    }

    const itemsColumn = card.querySelector(":scope > .row .items-col");
    if (itemsColumn && isGiftable(card)) {
      ensureInfoLine(itemsColumn, "giftable", "Giftable");
    }
  }

  function ensureInfoLine(container, key, text, options = {}) {
    let line = container.querySelector(`:scope > [data-hh-info-line="${key}"]`);
    if (!line) {
      line = document.createElement("div");
      line.dataset.hhInfoLine = key;
      line.setAttribute(STYLE_MARKER, "info-line");
      if (options.prepend) {
        container.insertBefore(line, container.firstChild);
      } else {
        container.appendChild(line);
      }
    }

    line.dataset.hhImportant = String(Boolean(options.important));
    line.textContent = text;
  }

  function getMeltValue(card) {
    const valueInput = card.querySelector(":scope > .row .js-pledge-value");
    const label = valueInput instanceof HTMLInputElement ? valueInput.value.trim() : "";
    const amount = Number(label.replace(/[^0-9.]/g, ""));

    return {
      amount: Number.isNaN(amount) ? 0 : amount,
      label
    };
  }

  function isGiftable(card) {
    return Boolean(card.querySelector(
      ":scope > .row .js-gift, :scope > .row [class*='gift'], :scope > .row [href*='gift']"
    ));
  }

  function getHighestInsurance(card) {
    const insuranceItems = Array.from(card.querySelectorAll(":scope > .row .items.more.js-more .item"))
      .map(getInsuranceFromItem)
      .filter(Boolean)
      .sort((left, right) => right.rank - left.rank);

    return insuranceItems[0] ?? null;
  }

  function getInsuranceFromItem(item) {
    const title = normalizeTitle(item.querySelector(".title")?.textContent ?? item.textContent ?? "");
    const kind = normalizeTitle(item.querySelector(".kind")?.textContent ?? "");
    const text = `${title} ${kind}`;

    if (!/insurance/i.test(text)) {
      return null;
    }

    if (/lifetime|lti/i.test(text)) {
      return {
        label: "Lifetime Insurance",
        rank: Number.MAX_SAFE_INTEGER
      };
    }

    const monthMatch = text.match(/(\d+)\s*(?:month|mo)\b/i);
    if (!monthMatch) {
      return null;
    }

    const months = Number(monthMatch[1]);
    return {
      label: `${months} Month Insurance`,
      rank: months
    };
  }

  function applyGroupState(group) {
    const expanded = group.summary.dataset.hhExpanded === "true";

    group.summary.setAttribute("aria-expanded", String(expanded));
    group.summary.dataset.hhState = expanded ? "expanded" : "collapsed";
    group.cards.forEach((card) => {
      card.dataset.hhState = expanded ? "expanded" : "collapsed";
    });
  }

  function ensureReadOnlyDetailsToggle(card) {
    const details = card.querySelector(":scope > .row .items.more.js-more");
    const rsiExpandArrow = card.querySelector(":scope > .row .js-expand-arrow");

    if (!(details instanceof HTMLElement) || !(rsiExpandArrow instanceof HTMLElement)) {
      return;
    }

    if (!card.dataset.hhDetailsExpanded) {
      card.dataset.hhDetailsExpanded = "false";
      applyReadOnlyDetailsState(card);
    }

    if (!card.dataset.hhDetailsListenerAttached) {
      rsiExpandArrow.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        card.dataset.hhDetailsExpanded = card.dataset.hhDetailsExpanded === "true" ? "false" : "true";
        applyReadOnlyDetailsState(card);
      }, true);
      card.dataset.hhDetailsListenerAttached = "true";
    }
  }

  function applyReadOnlyDetailsState(card) {
    const expanded = card.dataset.hhDetailsExpanded === "true";
    const row = card.querySelector(":scope > .row");
    const details = card.querySelector(":scope > .row .items.more.js-more");
    const rsiExpandArrow = card.querySelector(":scope > .row .js-expand-arrow");

    [row, details, rsiExpandArrow].forEach((element) => {
      if (element instanceof HTMLElement) {
        element.classList.toggle("active", expanded);
        element.classList.toggle("open", expanded);
        element.classList.toggle("opened", expanded);
        element.classList.toggle("expanded", expanded);
      }
    });

    if (details instanceof HTMLElement) {
      if (expanded) {
        details.removeAttribute("hidden");
        details.style.display = "block";
        details.style.height = `${details.scrollHeight}px`;
        details.style.overflow = "visible";
      } else {
        details.hidden = true;
        details.style.display = "none";
        details.style.height = "0";
        details.style.overflow = "hidden";
      }
    }

    if (rsiExpandArrow instanceof HTMLElement) {
      rsiExpandArrow.setAttribute("aria-expanded", String(expanded));
    }
  }

  function applyLocalPageSize(groups) {
    currentGroups.forEach((group) => {
      group.summary.dataset.hhPageState = "hidden";
      group.cards.forEach((card) => {
        card.dataset.hhPageState = "hidden";
      });
    });

    if (isBuyBackPage()) {
      findBuyBackCards().forEach((card) => {
        card.dataset.hhPageState = "hidden";
        card.setAttribute(STYLE_MARKER, "buyback-card");
      });
    }

    groups.forEach((group, index) => {
      const start = (currentPage - 1) * pageSize;
      const end = start + pageSize;
      const pageState = index < start || index >= end ? "hidden" : "visible";
      group.summary.dataset.hhPageState = pageState;
      group.cards.forEach((card) => {
        card.dataset.hhPageState = pageState;
      });
    });
  }

  function getTotalPages(totalGroups = currentFilteredGroups.length) {
    return Math.max(1, Math.ceil(totalGroups / pageSize));
  }

  function ensureBottomPager(parent) {
    let pager = parent.querySelector(":scope > [data-hh-pager='bottom']");
    if (!pager) {
      pager = document.createElement("li");
      pager.className = "hh-local-pager hh-local-pager-bottom";
      pager.dataset.hhPager = "bottom";
      pager.addEventListener("click", handlePagerClick);
    }

    return pager;
  }

  function updateLocalPagers() {
    document.querySelectorAll("[data-hh-pager]").forEach((pager) => {
      pager.innerHTML = getPagerHtml();
    });
  }

  function getPagerHtml() {
    const totalPages = getTotalPages();
    const pages = [];
    const firstPage = Math.max(1, currentPage - 2);
    const lastPage = Math.min(totalPages, firstPage + 4);

    for (let page = firstPage; page <= lastPage; page += 1) {
      pages.push(`<button type="button" data-hh-page="${page}"${page === currentPage ? " class=\"active\"" : ""}>${page}</button>`);
    }

    return `
      <button type="button" data-hh-page-action="first"${currentPage <= 1 ? " disabled" : ""}>«</button>
      <button type="button" data-hh-page-action="previous"${currentPage <= 1 ? " disabled" : ""}>‹</button>
      ${pages.join("")}
      <button type="button" data-hh-page-action="next"${currentPage >= totalPages ? " disabled" : ""}>›</button>
      <button type="button" data-hh-page-action="last"${currentPage >= totalPages ? " disabled" : ""}>»</button>
    `;
  }

  function handlePagerClick(event) {
    const button = event.target.closest("button");
    if (!button) {
      return;
    }

    const totalPages = getTotalPages();
    if (button.dataset.hhPage) {
      currentPage = Number(button.dataset.hhPage);
    } else if (button.dataset.hhPageAction === "first") {
      currentPage = 1;
    } else if (button.dataset.hhPageAction === "previous") {
      currentPage = Math.max(1, currentPage - 1);
    } else if (button.dataset.hhPageAction === "next") {
      currentPage = Math.min(totalPages, currentPage + 1);
    } else if (button.dataset.hhPageAction === "last") {
      currentPage = totalPages;
    }

    applyLocalPageSize(currentFilteredGroups);
    updateLocalPagers();
    updateStatus(document.getElementById(ROOT_ID), currentFilteredGroups.length, getFilteredPledgeCount(), currentTotalCards);
  }

  async function loadAllPledgeCards(currentPageCards) {
    const pageUrls = getPledgePageUrls(document);
    if (pageUrls.length <= 1) {
      return currentPageCards;
    }

    const currentUrl = normalizeUrl(window.location.href);
    const cards = [...currentPageCards];
    const urlsToFetch = pageUrls
      .map((pageUrl, index) => ({ index, pageUrl }))
      .filter(({ pageUrl }) => normalizeUrl(pageUrl) !== currentUrl);
    let loadedPages = 1;

    for (let offset = 0; offset < urlsToFetch.length; offset += FETCH_CONCURRENCY) {
      const batch = urlsToFetch.slice(offset, offset + FETCH_CONCURRENCY);
      const pageRange = `${batch[0].index + 1}-${batch[batch.length - 1].index + 1}`;
      setToolbarLoading(cards.length, `Loading pledge pages ${pageRange} of ${pageUrls.length}...`);

      const pageDocuments = await Promise.all(batch.map(async ({ pageUrl }) => {
        try {
          return await fetchPledgePage(pageUrl);
        } catch (error) {
          console.warn("Hangar Helper could not load pledge page", pageUrl, error);
          return null;
        }
      }));

      pageDocuments.forEach((pageDocument) => {
        if (pageDocument) {
          cards.push(...importPledgeCards(pageDocument));
          loadedPages += 1;
        }
      });

      setToolbarLoading(cards.length, `Loaded ${loadedPages} of ${pageUrls.length} pledge pages...`);
    }

    return dedupeCards(cards);
  }

  function getPledgePageUrls(sourceDocument) {
    const urls = new Set([normalizeUrl(window.location.href)]);

    sourceDocument.querySelectorAll(".pager-wrapper a[href*='page='], .pager a[href*='page=']").forEach((link) => {
      const href = link.getAttribute("href");
      if (href) {
        urls.add(normalizeUrl(href));
      }
    });

    const maxPage = Array.from(urls).reduce((max, url) => {
      return Math.max(max, Number(new URL(url).searchParams.get("page") ?? "1"));
    }, 1);

    for (let page = 1; page <= maxPage; page += 1) {
      const url = new URL(window.location.href);
      url.pathname = "/account/pledges";
      url.search = "";
      url.searchParams.set("page", String(page));
      urls.add(normalizeUrl(url.href));
    }

    return Array.from(urls).sort((left, right) => {
      return Number(new URL(left).searchParams.get("page") ?? "1") - Number(new URL(right).searchParams.get("page") ?? "1");
    });
  }

  async function fetchPledgePage(url) {
    const cachedHtml = getCachedPledgePage(url);
    if (cachedHtml) {
      return parsePledgePage(cachedHtml);
    }

    return fetchPledgePageFresh(url);
  }

  async function fetchPledgePageFresh(url) {
    const response = await fetch(url, {
      credentials: "same-origin"
    });

    if (!response.ok) {
      throw new Error(`Unable to load pledge page: ${response.status}`);
    }

    const html = await response.text();
    setCachedPledgePage(url, html);
    return parsePledgePage(html);
  }

  function parsePledgePage(html) {
    return new DOMParser().parseFromString(html, "text/html");
  }

  function getCachedPledgePage(url) {
    try {
      const cached = JSON.parse(sessionStorage.getItem(getPageCacheKey(url)) ?? "null");
      if (!cached) {
        return null;
      }

      return cached.html;
    } catch {
      return null;
    }
  }

  function setCachedPledgePage(url, html) {
    try {
      sessionStorage.setItem(getPageCacheKey(url), JSON.stringify({
        createdAt: Date.now(),
        html
      }));
    } catch {
      // Ignore quota errors; caching is only a performance optimization.
    }
  }

  async function getCachedPledgeAggregate() {
    const cachedFromDb = await getSessionCacheEntry(PLEDGE_AGGREGATE_CACHE_KEY);
    if (Array.isArray(cachedFromDb?.cards)) {
      return cachedFromDb.cards
        .map(parseCachedPledgeEntry)
        .filter(Boolean);
    }

    try {
      const cached = JSON.parse(sessionStorage.getItem(PLEDGE_AGGREGATE_CACHE_KEY) ?? "null");
      if (!Array.isArray(cached?.cards)) {
        return [];
      }

      const cards = cached.cards
        .map(parseCachedPledgeEntry)
        .filter(Boolean);
      await setCachedPledgeAggregate(cards);
      sessionStorage.removeItem(PLEDGE_AGGREGATE_CACHE_KEY);
      return cards;
    } catch {
      return [];
    }
  }

  async function setCachedPledgeAggregate(cards) {
    const aggregate = {
      version: PLEDGE_AGGREGATE_CACHE_VERSION,
      createdAt: Date.now(),
      cards: cards.map((card) => ({
        html: card.outerHTML,
        metadata: getPledgeCardMetadata(card)
      }))
    };

    try {
      await setSessionCacheEntry(PLEDGE_AGGREGATE_CACHE_KEY, aggregate);
      clearPledgeHtmlPageCache();
      sessionStorage.removeItem(PLEDGE_AGGREGATE_CACHE_KEY);
    } catch (error) {
      clearPledgeHtmlPageCache();
      console.warn("Hangar Helper could not cache aggregated pledges", error);
    }
  }

  function parseCachedPledgeEntry(entry) {
    const html = typeof entry === "string" ? entry : entry?.html;
    const card = parseCachedPledgeCard(html);
    if (!card) {
      return null;
    }

    if (
      typeof entry === "object"
      && entry?.metadata?.version === PLEDGE_AGGREGATE_CACHE_VERSION
      && entry.metadata.createdAt
      && entry.metadata.displayTitle
      && entry.metadata.groupKey
    ) {
      pledgeCardMetadata.set(card, entry.metadata);
    } else {
      pledgeCardMetadata.set(card, classifyPledgeCard(card));
    }

    return card;
  }

  function parseCachedPledgeCard(html) {
    if (typeof html !== "string") {
      return null;
    }

    const template = document.createElement("template");
    template.innerHTML = html.trim();

    const card = template.content.firstElementChild;
    if (!(card instanceof HTMLElement) || !isLikelyPledgeCard(card)) {
      return null;
    }

    card.querySelectorAll("script").forEach((script) => script.remove());
    return card;
  }

  function getPageCacheKey(url) {
    return `${PAGE_CACHE_PREFIX}${normalizeUrl(url)}`;
  }

  function getSessionCacheKey(key) {
    return `${key}:${getSessionId()}`;
  }

  function getSessionId() {
    let sessionId = sessionStorage.getItem(SESSION_ID_KEY);
    if (!sessionId) {
      sessionId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
      sessionStorage.setItem(SESSION_ID_KEY, sessionId);
    }

    return sessionId;
  }

  function openCacheDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(CACHE_DB_NAME, CACHE_DB_VERSION);

      request.onupgradeneeded = () => {
        request.result.createObjectStore(CACHE_STORE_NAME, { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function getSessionCacheEntry(key) {
    try {
      const db = await openCacheDb();
      return await new Promise((resolve, reject) => {
        const request = db
          .transaction(CACHE_STORE_NAME, "readonly")
          .objectStore(CACHE_STORE_NAME)
          .get(getSessionCacheKey(key));

        request.onsuccess = () => resolve(request.result?.value ?? null);
        request.onerror = () => reject(request.error);
      });
    } catch {
      return null;
    }
  }

  async function setSessionCacheEntry(key, value) {
    const db = await openCacheDb();
    await new Promise((resolve, reject) => {
      const request = db
        .transaction(CACHE_STORE_NAME, "readwrite")
        .objectStore(CACHE_STORE_NAME)
        .put({
          key: getSessionCacheKey(key),
          updatedAt: Date.now(),
          value
        });

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async function deleteSessionCacheEntry(key) {
    try {
      const db = await openCacheDb();
      await new Promise((resolve, reject) => {
        const request = db
          .transaction(CACHE_STORE_NAME, "readwrite")
          .objectStore(CACHE_STORE_NAME)
          .delete(getSessionCacheKey(key));

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    } catch {
      // Cache deletion is best-effort.
    }
  }

  function clearPledgeHtmlPageCache() {
    Object.keys(sessionStorage)
      .filter((key) => key.startsWith(PAGE_CACHE_PREFIX))
      .filter((key) => key !== PLEDGE_AGGREGATE_CACHE_KEY)
      .filter((key) => key.includes("/account/pledges"))
      .forEach((key) => sessionStorage.removeItem(key));
  }

  async function clearPledgePageCache() {
    await deleteSessionCacheEntry(PLEDGE_AGGREGATE_CACHE_KEY);
    Object.keys(sessionStorage)
      .filter((key) => key.startsWith(PAGE_CACHE_PREFIX))
      .forEach((key) => sessionStorage.removeItem(key));
  }

  function startBackgroundRefresh() {
    if (refreshIntervalId) {
      return;
    }

    refreshIntervalId = window.setInterval(checkForNewPledges, CHECK_FOR_UPDATES_INTERVAL_MS);
  }

  async function checkForNewPledges() {
    if (refreshInProgress || currentCards.length === 0) {
      return;
    }

    refreshInProgress = true;

    try {
      const knownPledgeIds = new Set(currentCards.map(getPledgeId).filter(Boolean));
      const newCards = [];

      for (let page = 1; ; page += 1) {
        const pageUrl = getPledgePageUrl(page);
        const pageDocument = await fetchPledgePageFresh(pageUrl);
        const pageCards = importPledgeCards(pageDocument);

        if (pageCards.length === 0) {
          break;
        }

        const unknownCards = pageCards.filter((card) => {
          const pledgeId = getPledgeId(card);
          return pledgeId && !knownPledgeIds.has(pledgeId);
        });

        if (unknownCards.length === 0) {
          break;
        }

        unknownCards.forEach((card) => {
          const pledgeId = getPledgeId(card);
          if (pledgeId) {
            knownPledgeIds.add(pledgeId);
          }
          newCards.push(card);
        });
      }

      if (newCards.length > 0) {
        currentCards = dedupeCards([...newCards, ...currentCards]);
        await setCachedPledgeAggregate(currentCards);
        rebuildView();
        const toolbar = document.getElementById(ROOT_ID);
        updateStatus(toolbar, currentGroups.length, currentTotalCards);
      }
    } catch (error) {
      console.warn("Hangar Helper could not check for new pledges", error);
    } finally {
      refreshInProgress = false;
    }
  }

  function getPledgePageUrl(page) {
    const url = new URL(window.location.href);
    url.pathname = "/account/pledges";
    url.search = "";
    url.searchParams.set("page", String(page));
    return normalizeUrl(url.href);
  }

  function getPledgeId(card) {
    return card.querySelector(":scope > .row .js-pledge-id")?.value ?? "";
  }

  function importPledgeCards(sourceDocument) {
    return Array.from(sourceDocument.querySelectorAll(CARD_SELECTOR))
      .filter(isLikelyPledgeCard)
      .map((card) => {
        const imported = document.importNode(card, true);
        imported.querySelectorAll("script").forEach((script) => script.remove());
        return imported;
      });
  }

  function dedupeCards(cards) {
    const seenPledgeIds = new Set();

    return cards.filter((card) => {
      const pledgeId = card.querySelector(":scope > .row .js-pledge-id")?.value;
      const key = pledgeId || `${getPledgeTitle(card)}:${getCreatedAt(card).toISOString()}`;

      if (seenPledgeIds.has(key)) {
        return false;
      }

      seenPledgeIds.add(key);
      return true;
    });
  }

  function appendIfNeeded(parent, child) {
    if (child.parentElement !== parent || child.nextElementSibling !== null) {
      parent.appendChild(child);
    }
  }

  function normalizeUrl(value) {
    const url = new URL(value, window.location.origin);
    url.hash = "";
    return url.href;
  }

  function removeToolbar() {
    document.getElementById(ROOT_ID)?.remove();
  }

  function hideRsiPagers() {
    document.querySelectorAll(".pager-wrapper, .billing-title-pager-wrapper").forEach((pager) => {
      pager.setAttribute(STYLE_MARKER, "rsi-pager");
    });

    if (isBuyBackPage()) {
      document.querySelectorAll(".options-selector:not(.pager-wrapper), form.filters.legacy-form").forEach((selector) => {
        if (!selector.closest(`#${ROOT_ID}`)) {
          selector.setAttribute(STYLE_MARKER, "rsi-filter");
        }
      });
    }
  }

  function hidePledgeSpacer() {
    if (isBuyBackPage()) {
      return;
    }

    document.querySelectorAll("p").forEach((paragraph) => {
      if (paragraph.textContent.trim() !== "") {
        return;
      }

      const nextElement = paragraph.nextElementSibling;
      if (nextElement?.matches("ul.pledges, #hangar-helper-toolbar") || nextElement?.querySelector?.("#hangar-helper-toolbar")) {
        paragraph.setAttribute(STYLE_MARKER, "rsi-spacer");
      }
    });
  }

  function removeOrphanSummaries() {
    document.querySelectorAll(SUMMARY_SELECTOR).forEach((summary) => {
      const nextElement = summary.nextElementSibling;
      if (!nextElement || !isLikelyPledgeCard(nextElement)) {
        summary.remove();
      }
    });
  }

  function startObserver() {
    observer?.disconnect();
    observer = new MutationObserver((mutations) => {
      const shouldRender = mutations.some((mutation) => {
        return Array.from(mutation.addedNodes).some((node) => {
          return node instanceof HTMLElement
            && !node.closest(`#${ROOT_ID}`)
            && !node.matches(SUMMARY_SELECTOR)
            && node.getAttribute(STYLE_MARKER) !== "summary";
        });
      });
      if (shouldRender) {
        queueRender();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  function isBuyBackPage() {
    return /\/account\/buy-back-pledges\b/.test(window.location.pathname);
  }

  async function renderBuyBacks() {
    hideRsiPagers();

    const cards = findBuyBackCards();
    if (cards.length === 0) {
      ensureBuyBackToolbar(0, 0);
      return;
    }

    setCachedPledgePage(window.location.href, document.documentElement.outerHTML);
    ensureBuyBackToolbar(cards.length, cards.length);
    setBuyBackLoading("Loading buy-back pages...");

    currentCards = dedupeBuyBackCards(await loadAllBuyBackCards(cards));
    currentGroups = getBuyBackGroups(currentCards);
    currentFilteredGroups = getFilteredGroups();
    currentTotalCards = currentCards.length;
    currentPage = Math.min(currentPage, getTotalPages(currentFilteredGroups.length));
    isAggregated = true;

    enhanceBuyBackRows(currentGroups);
    applyLocalPageSize(currentFilteredGroups);
    updateLocalPagers();
    updateStatus(document.getElementById(ROOT_ID), currentFilteredGroups.length, getFilteredPledgeCount(), currentTotalCards);
  }

  function findBuyBackCards() {
    return Array.from(document.querySelectorAll(".available-pledges ul.pledges > li"))
      .filter((element) => !element.closest(`#${ROOT_ID}`))
      .filter((element) => element instanceof HTMLElement)
      .filter((element) => element.querySelector(":scope article.pledge .information h1"));
  }

  function ensureBuyBackToolbar(totalGroups, totalCards) {
    let toolbar = document.getElementById(ROOT_ID);

    if (!toolbar) {
      toolbar = document.createElement("section");
      toolbar.id = ROOT_ID;
      toolbar.setAttribute(STYLE_MARKER, "toolbar");
      toolbar.innerHTML = `
        <div class="hh-toolbar-row">
          <label class="hh-page-size">
            Pledges per page
            <select aria-label="Pledges per page" data-hh-page-size>
              ${PAGE_SIZES.map((size) => `<option value="${size}">${size}</option>`).join("")}
            </select>
          </label>
          <button type="button" data-hh-reload>Reload buybacks</button>
          <div class="hh-local-pager" data-hh-pager="top"></div>
          <div class="hh-status" data-hh-status></div>
        </div>
        <div class="hh-toolbar-row hh-filter-row">
          <label>
            Filter
            <select aria-label="Filter buybacks" data-hh-category-filter>
              <option value="all">All</option>
              <option value="game-package">Game package</option>
              <option value="ships">Ships</option>
              <option value="upgrades">Upgrades</option>
              <option value="skins">Skins</option>
              <option value="items">Items</option>
            </select>
          </label>
          <label class="hh-search">
            Search
            <input type="search" placeholder="Search buybacks" data-hh-search>
          </label>
        </div>
      `;

      toolbar.querySelector("[data-hh-page-size]").addEventListener("change", (event) => {
        pageSize = Number(event.target.value);
        currentPage = 1;
        applyCurrentFilters();
      });

      toolbar.querySelector("[data-hh-category-filter]").addEventListener("change", (event) => {
        currentCategoryFilter = event.target.value;
        currentPage = 1;
        applyCurrentFilters();
      });

      toolbar.querySelector("[data-hh-search]").addEventListener("input", (event) => {
        currentSearchTerm = event.target.value;
        currentPage = 1;
        applyCurrentFilters();
      });

      toolbar.querySelector("[data-hh-reload]").addEventListener("click", async () => {
        await clearPledgePageCache();
        currentCards = [];
        currentFilteredGroups = [];
        currentGroups = [];
        currentTotalCards = 0;
        currentPage = 1;
        isAggregated = false;
        await renderBuyBacks();
      });

      toolbar.querySelector("[data-hh-pager='top']").addEventListener("click", handlePagerClick);

      const list = getBuyBackList();
      if (list?.parentElement) {
        list.parentElement.insertBefore(toolbar, list);
      } else {
        document.body.prepend(toolbar);
      }
    }

    toolbar.querySelector("[data-hh-page-size]").value = String(pageSize);
    toolbar.querySelector("[data-hh-category-filter]").value = currentCategoryFilter;
    toolbar.querySelector("[data-hh-search]").value = currentSearchTerm;
    updateStatus(toolbar, totalGroups, getFilteredPledgeCount(), totalCards);
  }

  function setBuyBackLoading(message) {
    const diagnostic = document.querySelector(`#${ROOT_ID} [data-hh-status]`);
    if (diagnostic) {
      diagnostic.textContent = message;
    }
  }

  async function loadAllBuyBackCards(currentPageCards) {
    const pageUrls = getBuyBackPageUrls(document);
    if (pageUrls.length <= 1) {
      return currentPageCards;
    }

    const currentUrl = normalizeUrl(window.location.href);
    const cards = [...currentPageCards];
    const urlsToFetch = pageUrls.filter((pageUrl) => normalizeUrl(pageUrl) !== currentUrl);
    let loadedPages = 1;

    for (let offset = 0; offset < urlsToFetch.length; offset += FETCH_CONCURRENCY) {
      const batch = urlsToFetch.slice(offset, offset + FETCH_CONCURRENCY);
      setBuyBackLoading(`Loading buy-back pages ${offset + 1}-${offset + batch.length} of ${pageUrls.length}...`);

      const pageDocuments = await Promise.all(batch.map(async (pageUrl) => {
        try {
          return await fetchPledgePage(pageUrl);
        } catch (error) {
          console.warn("Hangar Helper could not load buy-back page", pageUrl, error);
          return null;
        }
      }));

      pageDocuments.forEach((pageDocument) => {
        if (pageDocument) {
          cards.push(...importBuyBackCards(pageDocument));
          loadedPages += 1;
        }
      });

      setBuyBackLoading(`Loaded ${loadedPages} of ${pageUrls.length} buy-back pages...`);
    }

    return cards;
  }

  function getBuyBackPageUrls(sourceDocument) {
    const urls = new Set([getBuyBackPageUrl(1)]);

    sourceDocument.querySelectorAll(".pager-wrapper a[href*='page='], .pager a[href*='page=']").forEach((link) => {
      const href = link.getAttribute("href");
      if (href) {
        const url = new URL(href, window.location.origin);
        urls.add(getBuyBackPageUrl(Number(url.searchParams.get("page") ?? "1")));
      }
    });

    const maxPage = Array.from(urls).reduce((max, url) => {
      return Math.max(max, Number(new URL(url).searchParams.get("page") ?? "1"));
    }, 1);

    for (let page = 1; page <= maxPage; page += 1) {
      urls.add(getBuyBackPageUrl(page));
    }

    return Array.from(urls).sort((left, right) => {
      return Number(new URL(left).searchParams.get("page") ?? "1") - Number(new URL(right).searchParams.get("page") ?? "1");
    });
  }

  function getBuyBackPageUrl(page) {
    const url = new URL(window.location.href);
    url.pathname = "/account/buy-back-pledges";
    url.search = "";
    url.searchParams.set("page", String(page));
    url.searchParams.set("pagesize", "100");
    return normalizeUrl(url.href);
  }

  function importBuyBackCards(sourceDocument) {
    return Array.from(sourceDocument.querySelectorAll(".available-pledges ul.pledges > li"))
      .filter((card) => card instanceof HTMLElement)
      .filter((card) => card.querySelector(":scope article.pledge .information h1"))
      .map((card) => {
        const imported = document.importNode(card, true);
        imported.querySelectorAll("script").forEach((script) => script.remove());
        return imported;
      });
  }

  function getBuyBackGroups(cards) {
    return cards.map((card, index) => ({
      cards: [card],
      createdAt: getBuyBackLastModifiedAt(card),
      key: `${getBuyBackTitle(card).toLocaleLowerCase()}:${index}`,
      summary: card,
      title: getBuyBackTitle(card)
    })).sort((left, right) => {
      const dateComparison = right.createdAt.getTime() - left.createdAt.getTime();
      return dateComparison || left.title.localeCompare(right.title);
    });
  }

  function getBuyBackTitle(card) {
    return cleanPledgeTitle(
      card.querySelector(".js-pledge-name")?.value
      ?? card.querySelector(":scope article.pledge .information h1")?.textContent
      ?? findHeadline(card)?.textContent
      ?? card.querySelector("[class*='title'], [class*='name']")?.textContent
      ?? "Buyback pledge"
    );
  }

  function getBuyBackContainedText(card) {
    const containedLabel = Array.from(card.querySelectorAll("dt"))
      .find((term) => /^contained$/i.test(normalizeTitle(term.textContent ?? "")));
    return normalizeTitle(containedLabel?.nextElementSibling?.textContent ?? "");
  }

  function getBuyBackLastModifiedAt(card) {
    const lastModifiedLabel = Array.from(card.querySelectorAll("dt"))
      .find((term) => /^last modified$/i.test(normalizeTitle(term.textContent ?? "")));
    const rawDate = normalizeTitle(lastModifiedLabel?.nextElementSibling?.textContent ?? "");
    const parsedDate = new Date(rawDate);

    return Number.isNaN(parsedDate.getTime()) ? new Date(0) : parsedDate;
  }

  function enhanceBuyBackRows(groups) {
    const parent = groups.find((group) => group.summary.isConnected && group.summary.parentElement)?.summary.parentElement
      ?? getBuyBackList();
    if (!parent) {
      return;
    }

    let bottomPager = ensureBottomPager(parent);
    groups.forEach((group) => {
      group.summary.setAttribute(STYLE_MARKER, "buyback-card");
      group.cards.forEach(ensureBuyPriceAnnotation);
      appendIfNeeded(parent, group.summary);
    });
    appendIfNeeded(parent, bottomPager);
  }

  function ensureBuyPriceAnnotation(card) {
    const buyPrice = getBuyPrice(card);
    if (!buyPrice) {
      return;
    }

    const target = card.querySelector(":scope > .row .date-col, :scope > .row .price-col, :scope > .row .title-col")
      ?? card.querySelector(":scope > .row");
    if (target) {
      ensureInfoLine(target, "buy-price", `Buy Price: ${buyPrice}`);
    }
  }

  function getBuyBackList() {
    return document.querySelector(".available-pledges ul.pledges");
  }

  function getBuyPrice(card) {
    const valueInput = Array.from(card.querySelectorAll("input")).find((input) => {
      const descriptor = `${input.className} ${input.name}`.toLocaleLowerCase();
      return /price|value|amount|cost/.test(descriptor) && /\$|\d/.test(input.value ?? "");
    });

    if (valueInput?.value) {
      return valueInput.value.trim();
    }

    const textMatch = normalizeTitle(card.textContent ?? "").match(/(?:buy\s*price|price|value):\s*([$€£]?\s*\d[\d,.]*(?:\s*USD)?)/i);
    return textMatch?.[1]?.trim() ?? "";
  }

  function dedupeBuyBackCards(cards) {
    const seen = new Set();
    return cards.filter((card) => {
      const key = card.querySelector(".js-pledge-id, input[value]")?.value
        ?? `${getBuyBackTitle(card)}:${normalizeTitle(card.textContent ?? "").slice(0, 120)}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  function start() {
    if (isBuyBackPage()) {
      renderBuyBacks();
    } else {
      render();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
