// backend/bookingDates.web.js
// Lecture des dates du site depuis BookingRequests
// Doit etre en backend pour avoir suppressAuth: true
//
// ✅ CORRECTION : expandDateRange utilise '<' (et non '<=') pour libérer le
//    jour de départ. Un client part à 11h, un autre arrive le même jour à 17h.
//    Le jour de départ (checkout) doit donc rester DISPONIBLE pour une nouvelle
//    arrivée — exactement comme la logique Airbnb (airbnbIcal.web.js).
//
// ✅ CORRECTION : on ne tronque plus à 200 réservations. L'ancienne version
//    faisait .limit(200) SANS filtrer les dates dans la requête → les vieilles
//    réservations (passées) consommaient le quota et pouvaient masquer une
//    réservation future → suite affichée disponible alors qu'elle est réservée
//    (double réservation, critique pour Milovat/Anayah qui n'ont pas de filet
//    Airbnb). On pagine désormais sur TOUTES les réservations non annulées.
//    La pagination ne filtre pas sur un nom de champ précis, donc elle marche
//    que la date de départ soit stockée sous 'checkoutIso' ou 'checkoutISO'.

import wixData from 'wix-data';
import { webMethod, Permissions } from 'wix-web-module';

const PAGE_SIZE  = 1000; // max autorisé par Wix Data pour un find()
const MAX_PAGES  = 50;   // garde-fou anti-boucle (jusqu'à 50 000 réservations)
const TIMEZONE   = 'Europe/Paris'; // ⚠️ à ajuster si l'établissement n'est pas en France

function toISODate(date) {
    return date.getFullYear() + '-' +
        String(date.getMonth() + 1).padStart(2, '0') + '-' +
        String(date.getDate()).padStart(2, '0');
}

function todayISOInTimezone(timeZone = TIMEZONE) {
    // Locale en-CA -> format YYYY-MM-DD directement, dans le fuseau donné
    // (évite le bug "today" calculé en UTC/heure serveur qui décale la date
    // proche de minuit).
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
}

function expandDateRange(startISO, endISO) {
    const dates = [];
    const d     = new Date(startISO + 'T00:00:00');
    const end   = new Date(endISO   + 'T00:00:00');
    let   count = 0;
    // '<' (et non '<=') : la nuit du jour de départ n'est PAS occupée.
    // Départ 11h / arrivée 17h le même jour → le checkout reste libre.
    while (d < end && count < 365) {
        dates.push(toISODate(d));
        d.setDate(d.getDate() + 1);
        count++;
    }
    return dates;
}

export const getWebsiteBookingDates = webMethod(
    Permissions.Anyone,
    async () => {
        const result = {};
        const today  = todayISOInTimezone();

        // ── Récupération paginée de TOUTES les réservations non annulées ──
        let page       = await wixData.query('BookingRequests')
            .ne('status', 'cancelled')
            .limit(PAGE_SIZE)
            .find({ suppressAuth: true });

        let totalSeen  = 0;
        let pageCount  = 0;

        while (true) {
            for (const item of page.items) {
                totalSeen++;
                const suiteKey    = item.suiteKey    || '';
                const checkinIso  = item.checkinIso  || item.checkinISO  || '';
                const checkoutIso = item.checkoutIso || item.checkoutISO || '';

                if (!suiteKey || !checkinIso || !checkoutIso) continue;
                if (checkoutIso < today) continue; // réservation passée → ignorée

                const key = suiteKey.toLowerCase();
                if (!result[key]) result[key] = [];
                result[key].push(...expandDateRange(checkinIso, checkoutIso));
            }

            pageCount++;
            if (!page.hasNext() || pageCount >= MAX_PAGES) {
                if (page.hasNext()) {
                    console.warn('[bookingDates] MAX_PAGES atteint — des réservations peuvent manquer');
                }
                break;
            }
            page = await page.next();
        }

        console.log('[bookingDates] réservations parcourues:', totalSeen);

        for (const key of Object.keys(result)) {
            result[key] = [...new Set(result[key])].sort();
        }

        console.log('[bookingDates] suites:', Object.keys(result));
        return result;
    }
);
