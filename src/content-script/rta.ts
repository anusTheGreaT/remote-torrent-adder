import { observe } from './mutations';
import { RTASettings } from '../models/settings';
import { deserializeSettings } from '../util/serializer';
import { GetSettingsMessage, IPreAddTorrentMessage, IUpdateActionBadgeTextMessage, UpdateActionBadgeText } from '../models/messages';
import { PreAddTorrentMessage } from '../models/messages';
import { isMatchedByRegexes } from '../util/utils';

let numFoundLinks: number;
let currentSettings: RTASettings | null = null;
loadSettingsAndRegisterActions();

function loadSettingsAndRegisterActions(attemptNumber: number = 0): void {
    numFoundLinks = 0;
    chrome.runtime.sendMessage({ action: UpdateActionBadgeText.action, text: '' } as IUpdateActionBadgeTextMessage);
    chrome.runtime.sendMessage(GetSettingsMessage, function (serializedSettings: string) {
        const settings: RTASettings = deserializeSettings(serializedSettings);
        currentSettings = settings;
        console.debug("Received settings from background script:", settings);
        if (!settings && attemptNumber < 3) {
            console.warn("Service worker might've been asleep. Retrying to load settings...");
            loadSettingsAndRegisterActions(attemptNumber + 1);
            return;
        }

        if (settings && settings.linkCatchingEnabled) {
            registerLinks(settings.linkCatchingRegexes);
            registerForms(settings.linkCatchingRegexes);
        }
    });
}

function registerLinks(linkRegexes: RegExp[]): void {
    observe('a', (element) => {
        if (element.href && (isMatchedByRegexes(element.href, linkRegexes) || isMagnetLink(element.href))) {
            registerAction(element, element.href);
        }
    });
}

function registerForms(linkRegexes: RegExp[]): void {
    observe('input,button', (element) => {
        const form = element.form;
        if (form && form.action && (isMatchedByRegexes(form.action, linkRegexes) || isMagnetLink(form.action))) {
            registerAction(element, form.action);
        }
    });
}

function isMagnetLink(url: string): boolean {
    return url && url.startsWith && url.startsWith('magnet:');
}

function incrementCounter(): void {
    chrome.runtime.sendMessage({ action: UpdateActionBadgeText.action, text: (++numFoundLinks).toString() } as IUpdateActionBadgeTextMessage);
}

function registerAction(element: Element, url: string): void {
    incrementCounter();
    console.debug(`Registered action for element: ${element.tagName}, URL: ${url}`);
    element.addEventListener('click', (event: MouseEvent) => {
        if (event.ctrlKey || event.shiftKey || event.altKey) {
            console.log("Clicked a recognized link, but RTA action was prevented due to pressed modifier keys.");
            return;
        }
        event.preventDefault();
        console.debug("Clicked form input");

        // Special-case: when on YggTorrent pages, try to build a magnet link from the page
        // using the torrent hash and an optional passkey (from settings or localStorage).
        let finalUrl = url;
        try {
            if (isYggtorrentDomain()) {
                const passkey = getYggPasskey();
                const yggMagnet = buildYggMagnetFromPage(passkey);
                if (yggMagnet) {
                    console.debug('Built YggTorrent magnet link from page, overriding URL.');
                    finalUrl = yggMagnet;
                }
            }
        } catch (err) {
            console.warn('Failed to build YggTorrent magnet:', err);
        }

        chrome.runtime.sendMessage({ action: PreAddTorrentMessage.action, url: finalUrl } as IPreAddTorrentMessage);
    });
}

// --- Helpers for YggTorrent special-case ---
function isYggtorrentDomain(): boolean {
    try {
        return /yggtorrent/i.test(window.location.hostname || '');
    } catch (e) {
        return false;
    }
}

function getYggPasskey(): string {
    // Prefer explicit setting on currentSettings if present, otherwise fall back to global/window/localStorage.
    try {
        const maybeFromSettings = (currentSettings as any)?.yggPasskey;
        if (maybeFromSettings) return maybeFromSettings;
        const fromWindow = (window as any).RTA_PASSKEY;
        if (fromWindow) return fromWindow;
        const fromStorage = localStorage.getItem('rta_passkey');
        if (fromStorage) return fromStorage;
    } catch (e) {
        // ignore
    }
    return '';
}

function buildYggMagnetFromPage(passkey: string): string | null {
    // Attempt to locate the info table and extract the torrent name and info-hash.
    const infoTable = document.querySelector('table.informations') as HTMLTableElement | null
        || document.querySelector('table.info') as HTMLTableElement | null
        || document.querySelector('table#torrentinfo') as HTMLTableElement | null;
    if (!infoTable) return null;

    try {
        // name: first row, last td
        const nameCell = infoTable.querySelector('tr:first-child td:last-child');
        const name = nameCell ? (nameCell.textContent || '').trim() : '';

        // hash: often in the 5th row last td according to the provided userscript.
        const hashCell = infoTable.querySelector('tr:nth-child(5) td:last-child');
        let hash = '';
        if (hashCell) {
            // clone & remove children to get only text
            const clone = hashCell.cloneNode(true) as HTMLElement;
            const children = Array.from(clone.querySelectorAll('*'));
            children.forEach(c => c.remove());
            hash = (clone.textContent || '').trim();
        } else {
            // fallback: try to find a 40-char hex in table text
            const text = infoTable.textContent || '';
            const m = text.match(/([A-Fa-f0-9]{40})/);
            if (m) hash = m[1];
        }

        if (!hash) return null;

        const trackerUrl = ['http://tracker.p2p-world.net:8080/', passkey, '/announce'].join('');
        const magnet = [
            'magnet:?xt=urn:btih:',
            hash,
            '&dn=',
            encodeURIComponent(name || 'torrent'),
            '&tr=',
            encodeURIComponent(trackerUrl)
        ].join('');
        return magnet;
    } catch (e) {
        console.warn('Error while parsing YggTorrent page:', e);
        return null;
    }
}
