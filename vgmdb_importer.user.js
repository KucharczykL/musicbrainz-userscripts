// ==UserScript==
// @name         Import VGMdb releases into MusicBrainz
// @namespace    https://github.com/murdos/musicbrainz-userscripts/
// @description  One-click importing of releases from vgmdb.net into MusicBrainz. Scrapes album pages directly, so it keeps working while the VGMdb API is unavailable.
// @version      2026.6.11.2
// @downloadURL  https://raw.githubusercontent.com/murdos/musicbrainz-userscripts/master/vgmdb_importer.user.js
// @updateURL    https://raw.githubusercontent.com/murdos/musicbrainz-userscripts/master/vgmdb_importer.user.js
// @match        https://vgmdb.net/album/*
// @match        https://vgmdb.net/artist/*
// @match        https://vgmdb.net/org/*
// @require      https://code.jquery.com/jquery-3.5.1.min.js
// @require      lib/mbimport.js
// @require      lib/logger.js
// @require      lib/mbimportstyle.js
// @icon         https://raw.githubusercontent.com/murdos/musicbrainz-userscripts/master/assets/images/Musicbrainz_import_logo.png
// ==/UserScript==

// prevent JQuery conflicts, see http://wiki.greasespot.net/@grant
this.$ = this.jQuery = jQuery.noConflict(true);

const VGMDB_LINK_TYPE = 86; // release: "VGMdb" relationship

$(document).ready(function () {
    MBImportStyle();

    const path = window.location.pathname;
    if (/^\/album\//.test(path)) {
        setupAlbumImport();
    } else if (/^\/artist\//.test(path)) {
        insertSearchUI('artist');
    } else if (/^\/org\//.test(path)) {
        insertSearchUI('label');
    }
});

///////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                              Album pages
///////////////////////////////////////////////////////////////////////////////////////////////////////////////////

function setupAlbumImport() {
    renderImportBox();

    // VGMdb loads tracklists for non-active language tabs on demand. Re-render
    // the import buttons whenever new tracklist content shows up, so that
    // clicking e.g. the "Japanese" tab makes a Japanese import button appear.
    const tracklistNode = document.getElementById('tracklist');
    if (tracklistNode) {
        let timer = null;
        const observer = new MutationObserver(function () {
            clearTimeout(timer);
            timer = setTimeout(renderImportBox, 250);
        });
        observer.observe(tracklistNode, { childList: true, subtree: true });
    }
}

function renderImportBox() {
    $('#mb_vgmdb_import').remove();

    const shared = parseSharedAlbumInfo();
    const tracklists = parseTracklists();
    orderTracklistsByPreference(tracklists);

    const releaseUrl = `${window.location.origin}${window.location.pathname}`;
    const editNote = MBImport.makeEditNote(releaseUrl, 'VGMdb');

    let buttonsHtml = '';
    tracklists.forEach(function (tracklist, index) {
        const release = buildRelease(shared, tracklist, releaseUrl);
        if (index === 0) {
            LOGGER.info('Parsed release: ', release);
        }
        const parameters = MBImport.buildFormParameters(release, editNote);
        let formHtml = MBImport.buildFormHTML(parameters);
        if (tracklists.length > 1 && tracklist.language) {
            formHtml = formHtml.replace('Import into MB', `Import into MB (${tracklist.language})`);
        }
        buttonsHtml += `<div style="margin: 5px 0 0 5px; display: inline-block">${formHtml}</div>`;
    });

    if (!tracklists.length) {
        buttonsHtml += '<div style="margin: 5px 0 0 5px; color: #ccc;" class="smallfont">No tracklist found on this page.</div>';
    }

    const searchRelease = buildRelease(shared, tracklists.length ? tracklists[0] : { language: '', discs: [] }, releaseUrl);
    buttonsHtml += `<div style="margin: 5px 0 0 5px; display: inline-block">${MBImport.buildSearchButton(searchRelease)}</div>`;

    const unloadedLanguages = getUnloadedTracklistLanguages(tracklists);
    let hintHtml = '';
    if (unloadedLanguages.length) {
        hintHtml = `<div style="padding: 5px 0 0 5px; color: #788990;" class="smallfont">Click the ${unloadedLanguages.join(
            ' / ',
        )} tracklist tab to import it.</div>`;
    }

    const boxHtml =
        '<div id="mb_vgmdb_import">' +
        '<div style="width: 250px; background-color: #1B273D">' +
        '<b class="rtop"><b></b></b>' +
        '<div style="padding: 6px 10px 0px 10px"><h3>MusicBrainz</h3></div>' +
        '</div>' +
        `<div style="width: 250px; background-color: #2F364F; padding-bottom: 6px">${buttonsHtml}${hintHtml}` +
        '<b class="rbot"><b></b></b>' +
        '</div>' +
        '<br style="clear: left" />' +
        '</div>';

    const $column = $('#rightcolumn');
    if ($column.length) {
        $column.prepend(boxHtml);
    } else {
        $('#innermain').prepend(boxHtml);
    }
}

/*
 * Builds the MBImport release object for one tracklist language,
 * combining it with the language independent album info.
 */
function buildRelease(shared, tracklist, releaseUrl) {
    const titleLang = languageNameToTitleLang(tracklist.language);
    const release = {
        title: multiLangText($('#innermain h1').first(), titleLang),
        artist_credit: shared.artist_credit,
        status: shared.status,
        secondary_types: shared.secondary_types,
        year: shared.year,
        month: shared.month,
        day: shared.day,
        country: shared.country,
        labels: shared.labels,
        barcode: shared.barcode,
        urls: [{ url: releaseUrl, link_type: VGMDB_LINK_TYPE }].concat(shared.urls),
        discs: tracklist.discs.map(function (disc) {
            return {
                title: discTitle(disc.heading),
                format: discFormat(disc.heading, shared.mediaFormat),
                tracks: disc.tracks,
            };
        }),
    };

    const sample = release.title + tracklist.discs.map(disc => disc.tracks.map(track => track.title).join(' ')).join(' ');
    const langAndScript = guessLanguageAndScript(tracklist.language, sample);
    release.language = langAndScript.language;
    release.script = langAndScript.script;

    return release;
}

///////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                     Album info / credits parsing
///////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/*
 * Parses everything that doesn't depend on the tracklist language:
 * date, barcode, catalog number, labels, status, types, country, URLs, artists.
 */
function parseSharedAlbumInfo() {
    const shared = {
        artist_credit: [],
        status: 'official',
        secondary_types: [],
        year: 0,
        month: 0,
        day: 0,
        country: null,
        labels: [],
        barcode: null,
        urls: [],
        mediaFormat: '',
    };

    const organizations = []; // { role, names: [] }
    const roleArtists = {}; // role label -> [artist names]
    let catno = null;
    const $infoTable = $('#innermain #rightfloat table').first();

    if ($infoTable.hasClass('bootleg')) {
        shared.status = 'bootleg';
    }

    $infoTable
        .find('tr')
        .add($('#collapse_credits table tr'))
        .each(function () {
            const $cells = $(this).children('td');
            if ($cells.length < 2) {
                return;
            }
            const label = multiLangText($cells.first().find('b').first(), 'en');
            const $value = $cells.eq(1);

            switch (label) {
                case 'Catalog Number':
                    catno = parseCatalogNumber($value);
                    break;
                case 'Barcode':
                    shared.barcode = parseBarcode($value);
                    break;
                case 'Release Date': {
                    const date = parseReleaseDate($value);
                    shared.year = date.year;
                    shared.month = date.month;
                    shared.day = date.day;
                    break;
                }
                case 'Publish Format':
                    if (shared.status !== 'bootleg') {
                        shared.status = mapStatus($value.text());
                    }
                    break;
                case 'Media Format':
                    shared.mediaFormat = cleanText($value.text());
                    break;
                case 'Classification':
                    shared.secondary_types = mapSecondaryTypes($value.text());
                    break;
                case 'Release Price':
                    shared.country = mapCountry($value.find('acronym').first().text());
                    break;
                case 'Label':
                case 'Publisher':
                case 'Manufacturer':
                case 'Distributor':
                case 'Retailer':
                case 'Exclusive Retailer':
                    organizations.push({ role: label, names: parseLinkedNames($value) });
                    break;
                case 'Organizations':
                    parseOrganizationsRow($value, organizations);
                    break;
                default:
                    roleArtists[label] = (roleArtists[label] || []).concat(parseLinkedNames($value));
                    break;
            }
        });

    const labelNames = pickLabelNames(organizations);
    shared.labels = labelNames.length
        ? labelNames.map(name => ({ name: name, catno: catno }))
        : catno
          ? [{ name: null, catno: catno }]
          : [];

    const artistNames = pickArtistNames(roleArtists);
    if (artistNames.length) {
        shared.artist_credit = MBImport.makeArtistCredits(artistNames);
    }

    shared.urls = parseExternalLinks();

    return shared;
}

function parseCatalogNumber($value) {
    // The first text in the cell is this release's catalog number. It may be
    // wrapped in a dropdown toggle link when there are reprints, whose own
    // catalog numbers follow in a popup menu.
    let catno = firstText($value[0]);
    if (catno) {
        catno = cleanText(catno.split('(')[0]);
    }
    return catno && catno !== 'N/A' ? catno : null;
}

/*
 * Returns the first non-empty text node content within a node, in document
 * order, ignoring scripts.
 */
function firstText(node) {
    if (node.nodeType === Node.TEXT_NODE) {
        return cleanText(node.nodeValue) ? node.nodeValue : null;
    }
    if (node.nodeType !== Node.ELEMENT_NODE || node.tagName === 'SCRIPT' || node.tagName === 'STYLE') {
        return null;
    }
    for (let child = node.firstChild; child; child = child.nextSibling) {
        const text = firstText(child);
        if (text) {
            return text;
        }
    }
    return null;
}

function parseBarcode($value) {
    const barcode = cleanText($value.text()).split('(')[0].trim();
    return /^[\d ]+$/.test(barcode) ? barcode.replace(/ /g, '') : null;
}

/*
 * The release date links to the release calendar, with the full date in the
 * URL fragment (e.g. calendar.php?year=2008&month=6#20080625). Partial dates
 * only have the query parameters, or are plain text.
 */
function parseReleaseDate($value) {
    const date = { year: 0, month: 0, day: 0 };
    const href = $value.find('a[href*="calendar.php"]').first().attr('href') || '';

    const full = href.match(/#(\d{8})$/);
    if (full) {
        date.year = parseInt(full[1].substring(0, 4), 10);
        date.month = parseInt(full[1].substring(4, 6), 10);
        date.day = parseInt(full[1].substring(6, 8), 10);
        return date;
    }

    const partial = href.match(/year=(\d{4})(?:&month=(\d{1,2}))?/);
    if (partial) {
        date.year = parseInt(partial[1], 10);
        if (partial[2]) {
            date.month = parseInt(partial[2], 10);
        }
        return date;
    }

    const text = cleanText($value.text());
    if (/^\d{4}$/.test(text)) {
        date.year = parseInt(text, 10);
    } else if (/^[A-Za-z]{3,9} \d{1,2}, \d{4}$/.test(text)) {
        const parsed = new Date(text);
        if (!isNaN(parsed.getTime())) {
            date.year = parsed.getFullYear();
            date.month = parsed.getMonth() + 1;
            date.day = parsed.getDate();
        }
    } else if (/^[A-Za-z]{3,9} \d{4}$/.test(text)) {
        const parsed = new Date(`${text.split(' ')[0]} 2, ${text.split(' ')[1]}`);
        if (!isNaN(parsed.getTime())) {
            date.year = parsed.getFullYear();
            date.month = parsed.getMonth() + 1;
        }
    }
    return date;
}

/*
 * Extracts artist or organization names from a table cell, in order. Names are
 * either links (with one nested <span> per language) or plain text separated by
 * commas. Parenthesized text like "(PROCYON STUDIO)" is an affiliation, not a name.
 */
function parseLinkedNames($value) {
    const names = [];
    $value.contents().each(function () {
        if (this.nodeType === Node.TEXT_NODE) {
            this.nodeValue.split(',').forEach(function (token) {
                const name = token.replace(/\s*\([^)]*\)\s*$/, '').trim();
                if (name && name !== 'etc.') {
                    names.push(name);
                }
            });
        } else if (this.nodeType === Node.ELEMENT_NODE && this.tagName === 'A') {
            const name = multiLangText($(this), 'en');
            if (name) {
                names.push(name);
            }
        }
    });
    return names;
}

/*
 * Some albums credit all organizations in a single "Organizations" row, with
 * the roles in parentheses after each name, e.g.
 * "OrgA (label), OrgB (publisher, distributor)".
 */
function parseOrganizationsRow($value, organizations) {
    // Long lists are collapsed; the "publisher_less" span holds the full list
    const $expanded = $value.find('span[id="publisher_less"]');
    const $container = $expanded.length ? $expanded : $value;
    let current = null;
    $container.contents().each(function () {
        if (this.nodeType === Node.ELEMENT_NODE && this.tagName === 'A') {
            if (current) {
                organizations.push(current);
            }
            current = { role: 'Organization', names: [multiLangText($(this), 'en')] };
        } else if (this.nodeType === Node.TEXT_NODE && current) {
            const roles = this.nodeValue.match(/\(([^)]*)\)/);
            if (roles) {
                if (/label/i.test(roles[1])) {
                    current.role = 'Label';
                } else if (/publisher/i.test(roles[1])) {
                    current.role = 'Publisher';
                } else {
                    current.role = cleanText(roles[1]);
                }
                organizations.push(current);
                current = null;
            }
        }
    });
    if (current) {
        organizations.push(current);
    }
}

/*
 * Picks the most label-like organizations for the MusicBrainz "labels" field:
 * the ones credited as label, otherwise as publisher, otherwise a single
 * organization of any other role.
 */
function pickLabelNames(organizations) {
    const byRole = {};
    organizations.forEach(function (org) {
        byRole[org.role] = (byRole[org.role] || []).concat(org.names);
    });
    if (byRole['Label'] && byRole['Label'].length) {
        return byRole['Label'];
    }
    if (byRole['Publisher'] && byRole['Publisher'].length) {
        return byRole['Publisher'];
    }
    const allNames = organizations.reduce((acc, org) => acc.concat(org.names), []);
    return allNames.length === 1 ? allNames : [];
}

/*
 * Picks the artists for the release artist credit: composers, with performers
 * as fallback (e.g. for vocal or drama albums without composer credits).
 */
function pickArtistNames(roleArtists) {
    const composers = [];
    const performers = [];
    Object.keys(roleArtists).forEach(function (role) {
        const lowered = role.toLowerCase();
        if (/composer|composed by/.test(lowered) || lowered === 'music') {
            roleArtists[role].forEach(name => composers.push(name));
        } else if (/^(performer|performed by|vocals|vocal)$/.test(lowered)) {
            roleArtists[role].forEach(name => performers.push(name));
        }
    });
    return unique(composers.length ? composers : performers);
}

///////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                            Tracklist parsing
///////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/*
 * Returns one entry per language tab whose tracklist is loaded in the page:
 * { language, discs: [ { heading, tracks } ] }. VGMdb only embeds the active
 * language on initial load, other languages appear after clicking their tab.
 */
function parseTracklists() {
    const tracklists = [];
    $('#tlnav a[rel]').each(function () {
        const language = cleanText($(this).text());
        const $tlSpan = $(`#tracklist span.tl[id="${$(this).attr('rel')}"]`);
        if (!$tlSpan.length) {
            return;
        }
        const discs = parseDiscs($tlSpan);
        if (discs.length) {
            tracklists.push({ language: language, discs: discs });
        }
    });

    if (!tracklists.length) {
        // No language tabs: take any tracklist content directly
        $('#tracklist span.tl').each(function () {
            const discs = parseDiscs($(this));
            if (discs.length) {
                tracklists.push({ language: '', discs: discs });
            }
        });
    }
    return tracklists;
}

/*
 * Each disc is a <span><b>Disc 1</b></span> heading followed by a <table>
 * of tracks. Other <span> siblings (disc length, totals) have no <b>.
 */
function parseDiscs($tlSpan) {
    const discs = [];
    let heading = '';
    $tlSpan.children().each(function () {
        if (this.tagName === 'TABLE') {
            const tracks = parseTracks($(this));
            if (tracks.length) {
                discs.push({ heading: heading, tracks: tracks });
            }
            heading = '';
        } else if (this.tagName === 'SPAN' && $(this).find('b').length) {
            heading = cleanText($(this).find('b').first().text());
        }
    });
    return discs;
}

function parseTracks($table) {
    const tracks = [];
    $table.find('tr.rolebit').each(function () {
        const $cells = $(this).children('td');
        if ($cells.length < 2) {
            return;
        }
        let number = cleanText($cells.first().text());
        if (/^\d+$/.test(number)) {
            number = String(parseInt(number, 10));
        }
        const title = cleanText($cells.eq(1).text());
        const duration = cleanText($cells.last().find('span.time').text());
        tracks.push({
            number: number,
            title: title,
            duration: /^\d+:\d{2}(:\d{2})?$/.test(duration) ? duration : '',
        });
    });
    return tracks;
}

/*
 * Order parsed tracklists by import preference: the printed tracklist
 * (usually Japanese or Korean) first, then English, then Romaji.
 */
function orderTracklistsByPreference(tracklists) {
    function rank(tracklist) {
        if (tracklist.language === 'Romaji') {
            return 2;
        }
        if (tracklist.language === 'English') {
            return 1;
        }
        return 0;
    }
    tracklists.sort((a, b) => rank(a) - rank(b));
}

function getUnloadedTracklistLanguages(tracklists) {
    const loaded = tracklists.map(tracklist => tracklist.language);
    const unloaded = [];
    $('#tlnav a[rel]').each(function () {
        const language = cleanText($(this).text());
        if (!loaded.includes(language)) {
            unloaded.push(language);
        }
    });
    return unloaded;
}

/*
 * Splits a disc heading like "Disc 2 (DVD) [MJCD-20126]" into a medium title,
 * ignoring the parts that aren't a real title (media format, catalog number).
 */
function discTitle(heading) {
    const match = heading.match(/^Disc\s+\d+\s*(.*)$/i);
    if (!match) {
        return heading || null;
    }
    let rest = match[1].replace(/\[[^\]]*\]/g, '').trim();
    rest = rest.replace(/^\((.*)\)$/, '$1').trim();
    if (!rest || extractVgmdbMedia(rest) === rest) {
        return null;
    }
    return rest;
}

function discFormat(heading, mediaFormat) {
    if (mediaFormat.includes('+')) {
        // Mixed media releases name the media in each disc heading
        const discMedia = extractVgmdbMedia(heading);
        return discMedia ? mapFormat(discMedia) : null;
    }
    const generalMedia = extractVgmdbMedia(mediaFormat);
    return generalMedia ? mapFormat(generalMedia) : null;
}

///////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                          External links parsing
///////////////////////////////////////////////////////////////////////////////////////////////////////////////////

function parseExternalLinks() {
    const urls = [];
    const seen = {};

    function addUrl(url, linkType) {
        if (url && !seen[url]) {
            seen[url] = true;
            urls.push({ url: url, link_type: linkType });
        }
    }

    rightColumnSection('Available at')
        .find('a')
        .each(function () {
            const url = resolveRedirect($(this).attr('href'));
            if (url) {
                const storeName = cleanText($(this).text());
                mapStoreLinkTypes(storeName).forEach(linkType => addUrl(url, linkType));
            }
        });

    rightColumnSection('Websites')
        .children('div')
        .children('div')
        .each(function () {
            const category = cleanText($(this).find('b').first().text());
            if (category !== 'Commercial' && category !== 'Official') {
                return;
            }
            $(this)
                .find('a[href]')
                .each(function () {
                    addUrl(resolveRedirect($(this).attr('href')), null);
                });
        });

    return urls;
}

/*
 * Finds the content box following the right column section header with the
 * given title (e.g. "Available at", "Websites").
 */
function rightColumnSection(title) {
    const $h3 = $('#rightcolumn h3').filter(function () {
        return cleanText($(this).text()) === title;
    });
    if (!$h3.length) {
        return $();
    }
    return $h3.closest('div').parent().next('div');
}

/*
 * External links go through /redirect/<id>/<scheme-less url>. Anything else
 * pointing to vgmdb.net itself (e.g. the marketplace) is not wanted.
 */
function resolveRedirect(href) {
    if (!href) {
        return null;
    }
    const redirect = href.match(/\/redirect\/\d+\/(.+)$/);
    if (redirect) {
        const target = redirect[1];
        return /^https?:\/\//.test(target) ? target : `https://${target}`;
    }
    if (/^https?:\/\//.test(href) && !/^https?:\/\/(www\.)?vgmdb\.net\//.test(href)) {
        return href;
    }
    return null;
}

///////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                         VGMdb -> MusicBrainz mappings
///////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/*
 * Returns MusicBrainz status based on VGMdb publish format.
 *
 * MusicBrainz: official, promotion, bootleg, pseudo
 * VGMdb, comma separated:
 *   * one of Commercial, Doujin/Indie, Bootleg
 *   * one of Limited Edition, Enclosure, First Press Bonus, Preorder Bonus,
 *     Retailer Bonus, Event Only, Promo/Gift/Reward, Rental
 */
function mapStatus(publishFormat) {
    if (publishFormat.includes('Bootleg')) {
        // Overrides promo
        return 'bootleg';
    } else if (publishFormat.includes('Promo/Gift/Reward')) {
        return 'promotion';
    }
    return 'official';
}

/*
 * Returns MusicBrainz secondary release group types based on VGMdb classification
 * (e.g. "Original Soundtrack", "Arrangement", "Drama, Vocal").
 */
function mapSecondaryTypes(classification) {
    const types = [];
    if (/Soundtrack/i.test(classification)) {
        types.push('soundtrack');
    }
    if (/Remix/i.test(classification)) {
        types.push('remix');
    }
    if (/Drama/i.test(classification)) {
        types.push('audio drama');
    }
    if (/Live/i.test(classification)) {
        types.push('live');
    }
    return types;
}

/*
 * Returns a MusicBrainz country based on the release price currency code,
 * e.g. "3360 JPY" was released in Japan.
 */
function mapCountry(currency) {
    const countries = {
        JPY: 'JP',
        USD: 'US',
        EUR: 'XE',
        GBP: 'GB',
        KRW: 'KR',
        CNY: 'CN',
        TWD: 'TW',
        HKD: 'HK',
        AUD: 'AU',
        CAD: 'CA',
        SGD: 'SG',
        PLN: 'PL',
        RUB: 'RU',
        SEK: 'SE',
        BRL: 'BR',
    };
    return countries[cleanText(currency)] || null;
}

/*
 * Returns a MusicBrainz format based on a VGMdb media format.
 */
function mapFormat(mediaFormat) {
    switch (mediaFormat) {
        case 'Flexi Disc':
            return 'Vinyl';
        case 'Digital':
        case 'Download Card':
            return 'Digital Media';
        case 'SA-CD':
            return 'SACD';
        case 'CD Video':
            return 'CDV';
        case 'Laser Disc':
            return 'LaserDisc';
        case 'Floppy Disc':
            return 'Other';
        case 'USB':
            return 'USB Flash Drive';
        case 'UHQCD':
        case 'Blu-spec CD':
        case 'Blu-spec CD2':
        case 'HQCD':
        case 'SHM-CD':
            return 'CD';
        default:
            return mediaFormat;
    }
}

/*
 * Returns the VGMdb style media format part of a string, or null if none is
 * found. If an album has only one type of media, the disc heading won't
 * contain a media format.
 */
function extractVgmdbMedia(s) {
    const match = s.match(
        /(Cassette|Vinyl|Flexi Disc|DVD|Digital|SA-CD|Other|CD Video|VHS|Blu-ray|Laser Disc|Floppy Disc|USB|Download Card|UHQCD|Blu-spec CD2|Blu-spec CD|HQCD|SHM-CD|PLAYBUTTON|MiniDisc|CD)/,
    );
    return match ? match[0] : null;
}

/*
 * Returns an array of appropriate MusicBrainz link types for a store name
 * from the "Available at" section.
 */
function mapStoreLinkTypes(storeName) {
    const amazonAsin = 77;
    const purchaseForMailOrder = 79;
    const purchaseForDownload = 74;
    const freeStreaming = 85;

    switch (storeName) {
        case 'Amazon':
        case 'Amazon.co.jp':
            return [amazonAsin];
        case 'iTunes':
        case 'e-onkyo':
        case 'OTOTOY':
            return [purchaseForDownload];
        case 'CDJapan':
        case 'Play-Asia':
        case 'YesAsia':
            return [purchaseForMailOrder];
        case 'Spotify':
            return [freeStreaming];
        default:
            return [null];
    }
}

/*
 * Maps a VGMdb tracklist language tab name to the lang attribute used by the
 * album title <span>s, so that the imported title matches the tracklist.
 */
function languageNameToTitleLang(languageName) {
    const langs = {
        English: 'en',
        Japanese: 'ja',
        Romaji: 'ja-Latn',
        Korean: 'ko',
        Chinese: 'zh',
        German: 'de',
        French: 'fr',
        Spanish: 'es',
        Italian: 'it',
    };
    return langs[languageName] || null;
}

/*
 * Guesses the MusicBrainz language and script fields from the tracklist
 * language tab name and the actual title text.
 */
function guessLanguageAndScript(languageName, sample) {
    const hasKana = /[\u3041-\u30ff]/.test(sample); // hiragana + katakana
    const hasCjk = /[\u4e00-\u9fff]/.test(sample); // kanji / hanzi
    const hasHangul = /[\uac00-\ud7af]/.test(sample);
    // Latin scripts (with extensions), general punctuation, letterlike and number symbols
    const isLatin = !hasKana && !hasCjk && !hasHangul && !/[^\u0020-\u024f\u2000-\u206f\u2100-\u214f]/.test(sample);

    switch (languageName) {
        case 'Japanese':
            return { language: 'jpn', script: hasKana || hasCjk ? 'Jpan' : isLatin ? 'Latn' : null };
        case 'Romaji':
            return { language: 'jpn', script: isLatin ? 'Latn' : null };
        case 'English':
            return isLatin ? { language: 'eng', script: 'Latn' } : { language: 'eng', script: null };
        case 'Korean':
            return { language: 'kor', script: hasHangul ? 'Kore' : isLatin ? 'Latn' : null };
        case 'Chinese':
            return { language: 'zho', script: null };
        case 'German':
            return { language: 'deu', script: isLatin ? 'Latn' : null };
        case 'French':
            return { language: 'fra', script: isLatin ? 'Latn' : null };
        case 'Spanish':
            return { language: 'spa', script: isLatin ? 'Latn' : null };
        case 'Italian':
            return { language: 'ita', script: isLatin ? 'Latn' : null };
        default:
            return { language: null, script: null };
    }
}

///////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                          Artist and organization pages
///////////////////////////////////////////////////////////////////////////////////////////////////////////////////

function insertSearchUI(entityType) {
    const name = multiLangText($('#innermain h1').first(), 'en');
    if (!name) {
        return;
    }

    const label = entityType === 'label' ? 'label' : 'artist';
    const searchFormHtml =
        `<form class="musicbrainz_import musicbrainz_import_search" action="https://musicbrainz.org/search" method="get" target="_blank" accept-charset="UTF-8">` +
        `<input type="hidden" name="query" value="${htmlEscapeAttribute(name)}" />` +
        `<input type="hidden" name="type" value="${entityType}" />` +
        '<input type="hidden" name="indexed" value="1" />' +
        `<button type="submit" title="Search for this ${label} in MusicBrainz (open a new tab)">Search ${label} in MB</button>` +
        '</form>';
    const boxHtml =
        '<div id="mb_vgmdb_import">' +
        '<div style="width: 250px; background-color: #1B273D">' +
        '<b class="rtop"><b></b></b>' +
        '<div style="padding: 6px 10px 0px 10px"><h3>MusicBrainz</h3></div>' +
        '</div>' +
        '<div style="width: 250px; background-color: #2F364F; padding-bottom: 6px">' +
        `<div style="margin: 5px 0 0 5px; display: inline-block">${searchFormHtml}</div>` +
        '<b class="rbot"><b></b></b>' +
        '</div>' +
        '<br style="clear: left" />' +
        '</div>';

    const $column = $('#rightcolumn');
    if ($column.length) {
        $column.prepend(boxHtml);
    } else {
        $('#innermain').prepend(boxHtml);
    }
}

///////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                  Helpers
///////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/*
 * VGMdb renders names in multiple languages as sibling <span lang="...">
 * elements of which only one is displayed. Returns the text in the requested
 * language, falling back to English, then to the first available language,
 * then to the element's own text. " / " separators for multi-title display
 * are wrapped in <em> elements and must be ignored.
 */
function multiLangText($container, langCode) {
    const $spans = $container.find('span[lang]');
    let $pick;
    if (!$spans.length) {
        $pick = $container;
    } else {
        $pick = langCode ? $spans.filter(`[lang="${langCode}"]`) : $();
        if (!$pick.length) {
            $pick = $spans.filter('[lang="en"]');
        }
        if (!$pick.length) {
            $pick = $spans.first();
        }
    }
    const $clone = $pick.first().clone();
    $clone.find('em').remove();
    return cleanText($clone.text());
}

function cleanText(text) {
    // Remove zero width spaces, collapse the rest
    return (text || '')
        .replace(/\u200b/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function htmlEscapeAttribute(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function unique(values) {
    return values.filter((value, index) => values.indexOf(value) === index);
}
