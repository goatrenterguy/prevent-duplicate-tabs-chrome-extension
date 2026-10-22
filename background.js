importScripts('url-rules.js', 'dedupe.js');

let preventedDuplicatesCount = 0;
let active = true;
// When on, only tabs that were just opened are switched away from. When off,
// any tab that navigates to an already open page is, as in older versions.
let onlyNewTabs = true;
// The URL matching rules as written in the options page, and compiled.
let urlRules = [];
let compiledUrlRules = [];

// The accent color, chosen in the popup, is used for the toolbar icon, the
// badge and the "switched" notice. While the extension is switched off the icon
// and badge turn grey and the badge says OFF.
const DEFAULT_ACCENT_COLOR = '#0a84ff';
const OFF_COLOR = '#8e8e93';
let accentColor = DEFAULT_ACCENT_COLOR;

function isAccentColor(value) {
    return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

// Badge bookkeeping: the recount generation and what the badge currently shows.
let badgeGeneration = 0;
let lastBadgeText = null;
let lastBadgeColor = null;

// Tabs this extension is closing right now, so their own events are ignored.
const tabsBeingHandled = new Set();

// Checks for one URL run one at a time: two tabs that arrive at the same URL in
// the same moment - ctrl-clicking a link twice, restoring a session, "open all
// bookmarks" - would otherwise each pick the other as the tab to keep and then
// close themselves, leaving no tab on that URL at all. Queueing instead of
// skipping means a third and fourth tab are still deduplicated, each against a
// freshly queried tab list.
const queueByKey = new Map();

// Tabs that were opened and have not finished loading a real page yet: a link or
// search opened in a new tab, a link from another app, or a new tab page that an
// address is being typed into. With `onlyNewTabs` on these are the only tabs
// that are ever closed, so following a link or going back in a tab you are
// already using never closes it. Loading a page ends a tab's time as a new tab,
// which still lets redirects (http to https, link shorteners) be caught. Kept
// in chrome.storage.session so a worker restart in the middle of a page load
// does not forget them.
const newTabs = new Set();
const newTabsReady = chrome.storage.session.get('newTabs').then(stored => {
    (stored.newTabs ?? []).forEach(id => newTabs.add(id));
}).catch(e => {
    console.warn('Prevent Duplicate Tabs: could not read the new tabs', e);
});

// MV3 service workers can be terminated and restarted at any time, so the
// on/off switch, URL rules and counter are persisted in chrome.storage.local.
// Everything that reads or writes them awaits `stateReady` first: a write must
// never land before the persisted values have been loaded (that would overwrite
// them with stale defaults), and a tab event must never be judged against the
// defaults either.
const stateReady = chrome.storage.local.get(['active', 'onlyNewTabs', 'accentColor', 'urlRules', 'preventedDuplicatesCount']).then(stored => {
    active = stored.active ?? true;
    onlyNewTabs = stored.onlyNewTabs ?? true;
    accentColor = isAccentColor(stored.accentColor) ? stored.accentColor : DEFAULT_ACCENT_COLOR;
    preventedDuplicatesCount = stored.preventedDuplicatesCount ?? 0;
    try {
        compiledUrlRules = compileUrlRules(stored.urlRules ?? []);
        urlRules = stored.urlRules ?? [];
    } catch (e) {
        // Rules are checked before they are saved, so this takes a table saved
        // by a version of the extension that understood more than this one.
        // It is kept in storage, for the options page to show and fix.
        console.warn('Prevent Duplicate Tabs: ignoring the stored URL rules', e);
        urlRules = stored.urlRules;
    }
}).catch(e => {
    // Carry on with the defaults instead of rejecting: every tab event awaits
    // this promise, and a rejected one would throw on each of them.
    console.warn('Prevent Duplicate Tabs: could not read the stored state', e);
});

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === 'SetActive') {
        void stateReady
            .then(() => {
                active = Boolean(request.active);
                persistState();
                // Switched off, the badge says OFF instead of counting.
                void updateBadge();
                void updateIcon();
                sendResponse(currentState());
            })
            .catch(e => console.warn('Prevent Duplicate Tabs: could not switch the extension', e));
        return true;
    }
    if (request.action === 'SetOnlyNewTabs') {
        void stateReady
            .then(() => {
                onlyNewTabs = Boolean(request.onlyNewTabs);
                persistState();
                sendResponse(currentState());
            })
            .catch(e => console.warn('Prevent Duplicate Tabs: could not switch the new tabs option', e));
        return true;
    }
    if (request.action === 'SetAccentColor') {
        void stateReady
            .then(() => {
                if (isAccentColor(request.accentColor)) {
                    accentColor = request.accentColor.toLowerCase();
                    persistState();
                    void updateBadge();
                    void updateIcon();
                }
                sendResponse(currentState());
            })
            .catch(e => console.warn('Prevent Duplicate Tabs: could not change the color', e));
        return true;
    }
    if (request.action === 'SetUrlRules') {
        void stateReady
            .then(() => {
                let compiled;
                try {
                    compiled = compileUrlRules(request.urlRules);
                } catch (e) {
                    // Refused rules leave the current ones in place.
                    sendResponse({ ...currentState(), error: e.message });
                    return;
                }
                urlRules = request.urlRules;
                compiledUrlRules = compiled;
                persistState();
                // Which URLs count as duplicates just changed, so the badge does too.
                void updateBadge();
                sendResponse(currentState());
            })
            .catch(e => console.warn('Prevent Duplicate Tabs: could not save the URL rules', e));
        return true;
    }
    if (request.action === 'Deduplicate') {
        void stateReady
            .then(() => deduplicateExistingTabs())
            .then(result => sendResponse({ ...result, ...currentState() }), e => {
                // No response on failure: the popup reports the closed message
                // port as an error instead of a bogus "0 duplicates" result.
                console.warn('Prevent Duplicate Tabs: could not deduplicate the open tabs', e);
            });
        return true;
    }
    if (request.action === 'GetState') {
        void stateReady
            .then(() => sendResponse(currentState()))
            .catch(e => console.warn('Prevent Duplicate Tabs: could not read the state', e));
        return true;
    }
    return false;
});

// The service worker is usually started *by* the tab event it has to handle, so
// these listeners await `stateReady` instead of bailing out while the persisted
// state is still loading. Bailing out would drop the first duplicate after every
// idle shutdown, which makes the extension look like it only works sometimes.
chrome.tabs.onCreated.addListener(async newTab => {
    void updateBadge();
    await newTabsReady;
    setNewTab(newTab.id, true);
    await stateReady;
    if (!active) return;
    await verifyAndDeduplicate(newTab);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (!changeInfo.url && changeInfo.status !== 'complete') return;
    await newTabsReady;
    const isNew = newTabs.has(tabId);
    // A new tab page or about:blank does not count as a loaded page: an address
    // may still be typed into it.
    if (changeInfo.status === 'complete' && duplicateKey(tab) !== null) {
        setNewTab(tabId, false);
    }
    if (!changeInfo.url) return;
    void updateBadge();
    await stateReady;
    if (!active || (onlyNewTabs && !isNew)) return;
    await verifyAndDeduplicate(tab);
});

// Tabs being closed (by the user or by this extension) and prerender swaps
// change how many duplicates are open, so recount for those too.
chrome.tabs.onRemoved.addListener(async tabId => {
    void updateBadge();
    await newTabsReady;
    setNewTab(tabId, false);
});

// Chrome can swap a new tab for a prerendered one when an address typed into it
// was already loaded in the background. The swapped-in tab arrives on its final
// URL without an update event, so it is checked here.
chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
    void updateBadge();
    await newTabsReady;
    const wasNew = newTabs.has(removedTabId);
    setNewTab(removedTabId, false);
    if (!wasNew) return;
    setNewTab(addedTabId, true);
    await stateReady;
    if (!active) return;
    const added = await chrome.tabs.get(addedTabId).catch(() => undefined);
    if (added) await verifyAndDeduplicate(added);
});

function setNewTab(tabId, isNew) {
    if (tabId === undefined || isNew === newTabs.has(tabId)) return;
    if (isNew) {
        newTabs.add(tabId);
    } else {
        newTabs.delete(tabId);
    }
    chrome.storage.session.set({ newTabs: [...newTabs] })
        .catch(e => console.warn('Prevent Duplicate Tabs: could not save the new tabs', e));
}

void updateBadge();
void updateIcon();

async function deduplicateExistingTabs() {
    const tabs = await chrome.tabs.query({});
    const { toClose, pinnedKept } = planDeduplication(tabs, compiledUrlRules);
    let closed = 0;
    if (toClose.length > 0) {
        toClose.forEach(id => tabsBeingHandled.add(id));
        // Removed one at a time and counted by outcome: passing every id to a
        // single chrome.tabs.remove call means one stale id - a tab the user
        // closed while the scan ran - rejects the whole batch and abandons the
        // rest of the duplicates.
        const outcomes = await Promise.allSettled(toClose.map(id => chrome.tabs.remove(id)));
        toClose.forEach(id => tabsBeingHandled.delete(id));
        closed = outcomes.filter(outcome => outcome.status === 'fulfilled').length;
        if (closed > 0) {
            preventedDuplicatesCount += closed;
            persistState();
        }
    }
    return { scanned: tabs.length, closed, pinnedKept };
}

// Closes a tab that duplicates one that is already open, then switches to the
// tab that was there first.
function verifyAndDeduplicate(tab) {
    const key = duplicateKey(tab, compiledUrlRules);
    if (key === null || tab.id === undefined || tabsBeingHandled.has(tab.id)) {
        return Promise.resolve();
    }
    const done = (queueByKey.get(key) ?? Promise.resolve())
        .then(() => switchToExistingTab(tab.id, key))
        .catch(e => console.warn('Prevent Duplicate Tabs: could not switch tabs', e))
        .finally(() => {
            if (queueByKey.get(key) === done) {
                queueByKey.delete(key);
            }
        });
    queueByKey.set(key, done);
    return done;
}

async function switchToExistingTab(currentTabId, key) {
    try {
        const tabs = await chrome.tabs.query({});
        const current = tabs.find(tab => tab.id === currentTabId);
        // The tab can be gone already (closed by the user or by a check that was
        // queued ahead of this one), pinned, or it may have navigated on since
        // it was queued - in which case closing it would close the page the user
        // is now looking at.
        if (!current || current.pinned || duplicateKey(current, compiledUrlRules) !== key) return;

        const existing = findExistingTab(tabs, currentTabId, key, compiledUrlRules);
        if (!existing) return;

        await chrome.tabs.update(existing.id, { active: true });
        if (existing.windowId !== undefined) {
            await chrome.windows.update(existing.windowId, { focused: true });
        }
        await chrome.tabs.remove(currentTabId);
        preventedDuplicatesCount++;
        persistState();
        showSwitchedNotice(existing.id);
    } catch (e) {
        console.warn('Prevent Duplicate Tabs: could not switch tabs', e);
    }
}

// Shows a small "Switched to existing tab" pill at the top of the page for a
// couple of seconds, in light or dark to match the system. Pages where scripts
// cannot run (chrome://, the Chrome Web Store, ...) are skipped silently;
// switching to the existing tab still happens.
function showSwitchedNotice(tabId) {
    chrome.scripting.executeScript({
        target: { tabId },
        // The accent color is checked to be a #rrggbb color before it is saved,
        // so it is safe to put into the notice's stylesheet.
        args: [accentColor],
        func: accent => {
            const id = '__prevent_duplicate_tabs_notice__';
            document.getElementById(id)?.remove();

            // The notice lives in a shadow root so the page's CSS cannot restyle
            // it. Its styles go in a constructed stylesheet and its content is
            // built node by node, because pages with a strict CSP or Trusted
            // Types block inline <style> and innerHTML.
            const host = document.createElement('div');
            host.id = id;
            host.style.cssText = 'all: initial; position: fixed; top: 14px; left: 50%; '
                + 'transform: translateX(-50%); z-index: 2147483647; pointer-events: none;';
            const root = host.attachShadow({ mode: 'closed' });
            const sheet = new CSSStyleSheet();
            sheet.replaceSync(`
                .toast {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    padding: 7px 14px 7px 8px;
                    font: 500 13px/18px -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
                    letter-spacing: -0.01em;
                    white-space: nowrap;
                    color: #1d1d1f;
                    background: rgba(255, 255, 255, 0.86);
                    backdrop-filter: blur(20px) saturate(180%);
                    -webkit-backdrop-filter: blur(20px) saturate(180%);
                    border: 0.5px solid rgba(0, 0, 0, 0.1);
                    border-radius: 999px;
                    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06), 0 6px 20px rgba(0, 0, 0, 0.1);
                    opacity: 0;
                    transform: translateY(-6px) scale(0.97);
                    transition: opacity 180ms cubic-bezier(0.22, 1, 0.36, 1),
                        transform 280ms cubic-bezier(0.22, 1, 0.36, 1);
                }
                .toast.shown { opacity: 1; transform: none; }
                .toast.leaving {
                    transition-duration: 160ms;
                    transition-timing-function: cubic-bezier(0.4, 0, 1, 1);
                }
                .icon {
                    flex: none;
                    display: grid;
                    place-items: center;
                    width: 20px;
                    height: 20px;
                    border-radius: 50%;
                    background: ${accent};
                }
                .host { color: #86868b; }
                @media (prefers-color-scheme: dark) {
                    .toast {
                        color: #f5f5f7;
                        background: rgba(44, 44, 46, 0.86);
                        border-color: rgba(255, 255, 255, 0.12);
                        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 8px 24px rgba(0, 0, 0, 0.4);
                    }
                    .host { color: #98989d; }
                }
                @media (prefers-reduced-motion: reduce) {
                    .toast, .toast.shown { transform: none; transition: opacity 150ms linear; }
                }
            `);
            root.adoptedStyleSheets = [sheet];

            const toast = document.createElement('div');
            toast.className = 'toast';
            toast.setAttribute('role', 'status');

            // The extension's own icon, a tab in front of a tab, drawn in white.
            const svgNs = 'http://www.w3.org/2000/svg';
            const icon = document.createElementNS(svgNs, 'svg');
            icon.setAttribute('viewBox', '0 0 16 16');
            icon.setAttribute('width', '12');
            icon.setAttribute('height', '12');
            const outline = document.createElementNS(svgNs, 'path');
            outline.setAttribute('d', 'M2 13.5V2.5h5.25l2 3H14v8Z');
            outline.setAttribute('fill', 'none');
            outline.setAttribute('stroke', 'white');
            outline.setAttribute('stroke-width', '1.7');
            outline.setAttribute('stroke-linejoin', 'round');
            const backTab = document.createElementNS(svgNs, 'path');
            backTab.setAttribute('d', 'M8.9 1.65H14.85v4.7H10.6Z');
            backTab.setAttribute('fill', 'white');
            icon.append(outline, backTab);
            const iconWrap = document.createElement('span');
            iconWrap.className = 'icon';
            iconWrap.append(icon);

            const label = document.createElement('span');
            label.textContent = 'Switched to existing tab';
            toast.append(iconWrap, label);
            if (location.hostname) {
                const hostLabel = document.createElement('span');
                hostLabel.className = 'host';
                hostLabel.textContent = location.hostname.replace(/^www\./, '');
                toast.append(hostLabel);
            }

            root.append(toast);
            document.documentElement.append(host);
            // Read layout once so the starting styles apply before the
            // transition to .shown begins.
            toast.getBoundingClientRect();
            toast.classList.add('shown');
            setTimeout(() => {
                toast.classList.add('leaving');
                toast.classList.remove('shown');
                setTimeout(() => host.remove(), 200);
            }, 2200);
        },
    }).catch(() => {});
}

function currentState() {
    return { active, onlyNewTabs, accentColor, urlRules, preventedDuplicatesCount };
}

function persistState() {
    chrome.storage.local.set({
        active,
        onlyNewTabs,
        accentColor,
        urlRules,
        preventedDuplicatesCount,
    }).catch(e => console.warn('Prevent Duplicate Tabs: could not save the state', e));
}

// The badge shows how many open tabs are duplicates of another open tab, or
// OFF while the extension is switched off. Recounts are taken one at a time and
// only the newest one is applied, so a slow recount can never overwrite the
// result of a later one. Both the on/off state and the count (through the URL
// rules) come from storage, so it waits for them to be loaded.
async function updateBadge() {
    const generation = ++badgeGeneration;
    try {
        await stateReady;
        // Nothing is being deduplicated while switched off, so there is nothing
        // to count.
        const duplicates = active ? countDuplicates(await chrome.tabs.query({}), compiledUrlRules) : 0;
        // Chrome truncates badge text to ~4 characters.
        const text = !active ? 'OFF' : duplicates === 0 ? '' : duplicates >= 1000 ? '999+' : `${duplicates}`;
        const color = active ? accentColor : OFF_COLOR;
        if (generation !== badgeGeneration) return;
        if (text !== lastBadgeText) {
            lastBadgeText = text;
            await chrome.action.setBadgeText({ text });
        }
        if (color !== lastBadgeColor) {
            lastBadgeColor = color;
            await chrome.action.setBadgeBackgroundColor({ color });
        }
    } catch (e) {
        console.warn('Prevent Duplicate Tabs: could not update the badge', e);
    }
}

// The packaged icons are drawn in the default blue. The toolbar icon is redrawn
// in the accent color, or grey while switched off, by painting that color over
// the icon's shape. Chrome remembers the drawn icon until it restarts or the
// extension reloads, and the worker redraws it each time it starts. Workers
// have no DOM, so this needs OffscreenCanvas; the tests run without one.
let iconGeneration = 0;

async function updateIcon() {
    if (typeof OffscreenCanvas === 'undefined') return;
    const generation = ++iconGeneration;
    try {
        await stateReady;
        const color = active ? accentColor : OFF_COLOR;
        const imageData = {};
        for (const size of [16, 32]) {
            const response = await fetch(chrome.runtime.getURL(`icon-${size}.png`));
            const bitmap = await createImageBitmap(await response.blob());
            const canvas = new OffscreenCanvas(size, size);
            const context = canvas.getContext('2d');
            context.drawImage(bitmap, 0, 0, size, size);
            context.globalCompositeOperation = 'source-in';
            context.fillStyle = color;
            context.fillRect(0, 0, size, size);
            imageData[size] = context.getImageData(0, 0, size, size);
        }
        if (generation !== iconGeneration) return;
        await chrome.action.setIcon({ imageData });
    } catch (e) {
        console.warn('Prevent Duplicate Tabs: could not update the icon', e);
    }
}
