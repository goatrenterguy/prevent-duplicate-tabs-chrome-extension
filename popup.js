const toggle = document.getElementById('toggle');
const onlyNewTabsToggle = document.getElementById('onlyNewTabs');
const stateLabel = document.getElementById('stateLabel');
const rulesLabel = document.getElementById('rulesLabel');
const openRules = document.getElementById('openRules');
const counter = document.getElementById('counter');
const deduplicate = document.getElementById('deduplicate');
const status = document.getElementById('status');
const swatches = document.getElementById('swatches');

const PRESET_COLORS = [
    ['Blue', '#0a84ff'],
    ['Indigo', '#5e5ce6'],
    ['Purple', '#bf5af2'],
    ['Pink', '#ff375f'],
    ['Orange', '#ff9f0a'],
    ['Green', '#30d158'],
    ['Graphite', '#636366'],
];

const setAccentColor = async accentColor => {
    try {
        render(await chrome.runtime.sendMessage({ action: 'SetAccentColor', accentColor }));
    } catch (e) {
        showError(e);
    }
};

const presetButtons = PRESET_COLORS.map(([name, color]) => {
    const button = document.createElement('button');
    button.className = 'swatch';
    button.title = name;
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-label', name);
    button.style.setProperty('--swatch', color);
    button.dataset.color = color;
    button.addEventListener('click', () => setAccentColor(color));
    swatches.append(button);
    return button;
});

// Any other color comes from the system color picker behind the rainbow swatch.
const custom = document.createElement('label');
custom.className = 'custom';
custom.title = 'Custom color';
const customSwatch = document.createElement('span');
customSwatch.className = 'swatch';
const customInput = document.createElement('input');
customInput.type = 'color';
customInput.setAttribute('aria-label', 'Custom color');
customInput.addEventListener('input', () => setAccentColor(customInput.value));
custom.append(customSwatch, customInput);
swatches.append(custom);

function renderAccentColor(accentColor) {
    document.documentElement.style.setProperty('--accent', accentColor);
    let isPreset = false;
    for (const button of presetButtons) {
        const selected = button.dataset.color === accentColor;
        button.setAttribute('aria-checked', String(selected));
        isPreset ||= selected;
    }
    custom.classList.toggle('selected', !isPreset);
    customInput.value = accentColor;
}

function render({ active, onlyNewTabs, accentColor, urlRules, preventedDuplicatesCount }) {
    toggle.checked = active;
    renderAccentColor(accentColor);
    onlyNewTabsToggle.checked = onlyNewTabs;
    stateLabel.textContent = active ? 'Enabled' : 'Disabled';
    const ruleCount = Array.isArray(urlRules) ? urlRules.length : 0;
    rulesLabel.textContent = `URL matching rules: ${ruleCount === 0 ? 'none' : ruleCount}`;
    counter.textContent = `Duplicates prevented so far: ${preventedDuplicatesCount}.`;
}

function showStatus(text, kind = '') {
    status.textContent = text;
    status.className = `status ${kind}`;
}

// The background service worker can fail to answer (it is starting up, or the
// extension was just reloaded), so every message shows the failure instead of
// leaving the popup silently stuck on whatever it happened to be displaying.
function showError(e) {
    showStatus(`Error: ${e?.message ?? e}`, 'error');
}

const plural = count => (count === 1 ? 'tab' : 'tabs');

toggle.addEventListener('change', async () => {
    try {
        render(await chrome.runtime.sendMessage({ action: 'SetActive', active: toggle.checked }));
    } catch (e) {
        showError(e);
    }
});

onlyNewTabsToggle.addEventListener('change', async () => {
    try {
        render(await chrome.runtime.sendMessage({ action: 'SetOnlyNewTabs', onlyNewTabs: onlyNewTabsToggle.checked }));
    } catch (e) {
        showError(e);
    }
});

openRules.addEventListener('click', event => {
    event.preventDefault();
    chrome.runtime.openOptionsPage().catch(showError);
});

deduplicate.addEventListener('click', async () => {
    deduplicate.disabled = true;
    showStatus('Scanning...');
    try {
        const result = await chrome.runtime.sendMessage({ action: 'Deduplicate' });
        render(result);
        let text = result.closed === 0
            ? `No duplicates closed across ${result.scanned} tabs.`
            : `Closed ${result.closed} duplicate ${plural(result.closed)} of ${result.scanned}.`;
        if (result.pinnedKept > 0) {
            text += ` Kept ${result.pinnedKept} pinned duplicate ${plural(result.pinnedKept)}.`;
        }
        showStatus(text, result.closed > 0 ? 'ok' : '');
    } catch (e) {
        showError(e);
    } finally {
        deduplicate.disabled = false;
    }
});

chrome.runtime.sendMessage({ action: 'GetState' }).then(render).catch(showError);
