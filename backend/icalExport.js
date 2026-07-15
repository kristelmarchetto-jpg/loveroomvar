// backend/icalExport.js
// ═══════════════════════════════════════════════════════════════
// Génère un fichier iCal (.ics) depuis la collection BookingRequests
// Utilisé pour la synchro inverse : Wix → Airbnb
//
// URL publique : https://www.loveroomvar.fr/ical?suite=arcadie
//
// ✅ CORRECTION : lecture des DEUX orthographes de champs de date
//    (checkinIso/checkinISO). Avant, une réservation stockée sous la
//    variante majuscule était silencieusement ignorée par l'export → non
//    bloquée sur Airbnb → double réservation possible.
// ✅ CORRECTION : pagination complète au lieu de .limit(500), pour ne
//    jamais tronquer les réservations futures d'une suite très demandée.
// ═══════════════════════════════════════════════════════════════

import wixData from 'wix-data';
import { ok, badRequest, serverError } from 'wix-http-functions';

// Suites valides (whitelist sécurité). Anayah et Milovat sont "site uniquement"
// (pas d'annonce Airbnb) : exporter leur .ics est sans effet mais inoffensif.
const VALID_SUITES = ['arcadie', 'ecrin', 'milovat', 'boreal'];

const PAGE_SIZE = 1000; // max autorisé par Wix Data pour un find()
const MAX_PAGES = 50;   // garde-fou anti-boucle
const TIMEZONE  = 'Europe/Paris'; // ⚠️ à ajuster si l'établissement n'est pas en France

// Lecture défensive des champs de date (deux orthographes possibles en base)
function getCheckin(b)  { return b.checkinIso  || b.checkinISO  || ''; }
function getCheckout(b) { return b.checkoutIso || b.checkoutISO || ''; }

// ─── HANDLER HTTP GET ──────────────────────────────────────────

export async function get_ical(request) {
    try {
        const suiteKey = (request.query.suite || '').toLowerCase().trim();

        // Validation
        if (!suiteKey || !VALID_SUITES.includes(suiteKey)) {
            return badRequest({
                headers: { 'Content-Type': 'text/plain' },
                body: 'Suite invalide. Valeurs acceptées : ' + VALID_SUITES.join(', ')
            });
        }

        const today = todayISOInTimezone();

        // Récupérer TOUTES les réservations actives pour cette suite (paginé)
        let page      = await wixData.query('BookingRequests')
            .eq('suiteKey', suiteKey)
            .ne('status',   'cancelled')
            .limit(PAGE_SIZE)
            .find({ suppressAuth: true });

        const allItems  = [];
        let   pageCount = 0;

        while (true) {
            allItems.push(...page.items);
            pageCount++;
            if (!page.hasNext() || pageCount >= MAX_PAGES) {
                if (page.hasNext()) {
                    console.warn('[icalExport] MAX_PAGES atteint pour', suiteKey, '— des réservations peuvent manquer');
                }
                break;
            }
            page = await page.next();
        }

        // Filtrer les réservations non expirées (jour de départ >= aujourd'hui)
        const activeBookings = allItems.filter(b => {
            const checkout = getCheckout(b);
            return checkout && checkout >= today;
        });

        // Générer le contenu iCal
        const icsContent = generateIcs(suiteKey, activeBookings);

        return ok({
            headers: {
                'Content-Type':        'text/calendar; charset=utf-8',
                'Content-Disposition': `attachment; filename="${suiteKey}.ics"`,
                'Cache-Control':       'no-cache, no-store, must-revalidate',
                'X-WR-CALNAME':        'LoveroomVar - ' + capitalize(suiteKey),
            },
            body: icsContent
        });

    } catch (error) {
        console.error('[icalExport] Erreur:', error.message);
        return serverError({
            headers: { 'Content-Type': 'text/plain' },
            body:    'Erreur serveur'
        });
    }
}

// ─── GÉNÉRATEUR iCal ───────────────────────────────────────────

function generateIcs(suiteKey, bookings) {
    const now    = formatIcsDateTime(new Date());
    const lines  = [];

    // En-tête calendrier
    lines.push('BEGIN:VCALENDAR');
    lines.push('VERSION:2.0');
    lines.push('PRODID:-//LoveroomVar//Booking System//FR');
    lines.push('CALSCALE:GREGORIAN');
    lines.push('METHOD:PUBLISH');
    lines.push('X-WR-CALNAME:LoveroomVar - ' + capitalize(suiteKey));
    lines.push('X-WR-TIMEZONE:Europe/Paris');
    lines.push('X-WR-CALDESC:Réservations LoveroomVar - Suite ' + capitalize(suiteKey));

    // Un événement par réservation
    for (const booking of bookings) {
        const checkinIso  = getCheckin(booking);
        const checkoutIso = getCheckout(booking);
        if (!checkinIso || !checkoutIso) continue;

        const uid       = `${booking._id}@loveroomvar.fr`;
        const dtstart   = formatIcsDate(checkinIso);
        const dtend     = formatIcsDate(checkoutIso);
        const summary   = 'Réservé - ' + capitalize(suiteKey);
        const createdAt = booking._createdDate
            ? formatIcsDateTime(new Date(booking._createdDate))
            : now;

        lines.push('BEGIN:VEVENT');
        lines.push('UID:'         + uid);
        lines.push('DTSTAMP:'     + now);
        lines.push('CREATED:'     + createdAt);
        lines.push('LAST-MODIFIED:' + now);
        lines.push('DTSTART;VALUE=DATE:' + dtstart);
        lines.push('DTEND;VALUE=DATE:'   + dtend);
        lines.push('SUMMARY:'     + summary);
        lines.push('STATUS:CONFIRMED');
        lines.push('TRANSP:OPAQUE');
        lines.push('END:VEVENT');
    }

    lines.push('END:VCALENDAR');

    // Jointure CRLF (standard iCal RFC 5545)
    return lines.join('\r\n') + '\r\n';
}

// ─── UTILITAIRES ───────────────────────────────────────────────

/**
 * Formate une date ISO en format iCal DATE : YYYYMMDD
 */
function formatIcsDate(isoDate) {
    return isoDate.replace(/-/g, '');
}

/**
 * Formate une Date JS en format iCal DATETIME : YYYYMMDDTHHmmssZ
 */
function formatIcsDateTime(date) {
    return date.getUTCFullYear() +
        String(date.getUTCMonth() + 1).padStart(2, '0') +
        String(date.getUTCDate()).padStart(2, '0') + 'T' +
        String(date.getUTCHours()).padStart(2, '0') +
        String(date.getUTCMinutes()).padStart(2, '0') +
        String(date.getUTCSeconds()).padStart(2, '0') + 'Z';
}

/**
 * Retourne la date du jour en ISO YYYY-MM-DD, dans le fuseau de l'établissement
 * (évite le décalage UTC proche de minuit).
 */
function todayISOInTimezone(timeZone = TIMEZONE) {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
}

function capitalize(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
}
