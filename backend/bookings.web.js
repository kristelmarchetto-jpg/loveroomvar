// backend/bookings.web.js
import wixData from 'wix-data';
import { webMethod, Permissions } from 'wix-web-module';
import { contacts, triggeredEmails } from 'wix-crm-backend';
import { getSecret } from 'wix-secrets-backend';

const COLLECTION            = 'BookingRequests';
const MAX_BOOKINGS_PER_HOUR = 3;
const MIN_FORM_FILL_MS      = 4000;
const TIMEZONE              = 'Europe/Paris'; // ⚠️ à ajuster si l'établissement n'est pas en France

// CORRECTION : anayah ajouté à la whitelist
const VALID_SUITE_KEYS = ['arcadie', 'ecrin', 'milovat', 'boreal', 'anayah'];

// Capacité maximale connue par suite. Seule celle d'Anayah est confirmée (4) ;
// les autres suites n'ont pas de plafond métier précisé ici — DEFAULT_MAX_GUESTS
// n'est qu'un garde-fou anti-données aberrantes, pas une vraie limite de capacité.
// ⚠️ À compléter avec les vraies capacités d'Arcadie/Écrin/Milovat/Boréal si elles diffèrent.
const SUITE_MAX_GUESTS   = { anayah: 4 };
const DEFAULT_MAX_GUESTS = 20;

function isISODate(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isValidEmail(s) {
    return typeof s === 'string' &&
        /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(s) &&
        s.length <= 150;
}

function isValidPhone(s) {
    if (typeof s !== 'string') return false;
    const digits = s.replace(/[^0-9]/g, '');
    return digits.length >= 8 && digits.length <= 15;
}

function isValidSuiteKey(s) {
    return VALID_SUITE_KEYS.includes((s || '').toLowerCase());
}

function maxGuestsForSuite(suiteKey) {
    return SUITE_MAX_GUESTS[(suiteKey || '').toLowerCase()] || DEFAULT_MAX_GUESTS;
}

function todayISOInTimezone(timeZone = TIMEZONE) {
    // Locale en-CA -> format YYYY-MM-DD directement, dans le fuseau donné
    // (évite le bug "today" calculé en UTC qui décale la date proche de minuit).
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
}

function sanitizeText(s, maxLength = 1000) {
    if (typeof s !== 'string') return '';
    return s
        .replace(/<[^>]*>/g, '')
        .replace(/[<>"'`]/g, '')
        .replace(/javascript:/gi, '')
        .trim()
        .slice(0, maxLength);
}

function formatDateFR(isoDate) {
    if (!isoDate) return '';
    try {
        return new Date(isoDate + 'T00:00:00').toLocaleDateString('fr-FR', {
            weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
        });
    } catch { return isoDate; }
}

function formatOptionsDetail(optionsRaw) {
    if (!optionsRaw) return 'Aucune option';
    try {
        const opts = typeof optionsRaw === 'string' ? JSON.parse(optionsRaw) : optionsRaw;
        if (!Array.isArray(opts) || opts.length === 0) return 'Aucune option';
        return opts.map(o => `${sanitizeText(o.label, 200)} (${Number(o.totalPrice) || 0}EUR)`).join('\n');
    } catch { return ''; }
}

function buildRecapText(data) {
    return [
        '=== RESERVATION ===',
        'Suite : '     + data.suiteName,
        'Arrivee : '   + data.checkinFormatted  + ' (17h)',
        'Depart : '    + data.checkoutFormatted + ' (11h)',
        'Duree : '     + data.nights + ' nuit(s) (' + data.weekendNights + ' WE + ' + data.weekdayNights + ' sem.)',
        'Voyageurs : ' + data.guests,
        '',
        '=== TARIFS ===',
        'Suite : '    + data.baseTotal    + 'EUR',
        'Options : '  + data.optionsTotal + 'EUR',
        data.optionsDetail !== 'Aucune option' ? data.optionsDetail : '',
        'TOTAL : '    + data.total        + 'EUR',
        '',
        '=== CLIENT ===',
        'Nom : '       + data.clientName,
        'Email : '     + data.clientEmail,
        'Telephone : ' + data.phone,
        data.message ? 'Message : ' + data.message : '',
        '',
        'Contacter le client pour lacompte.'
    ].filter(l => l !== '').join('\n');
}

function verifySecurityToken(token) {
    if (!token || typeof token !== 'string' || token.length > 500) {
        return { valid: false, reason: 'Token absent ou invalide' };
    }
    try {
        // Buffer plutôt que atob() : atob()/btoa() ne sont pas des globales
        // Node.js et ne sont pas disponibles dans le runtime backend Velo
        // (contrairement au code frontend/navigateur où atob() existe).
        const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf-8'));
        if (typeof decoded.d === 'number' && decoded.d < MIN_FORM_FILL_MS) {
            return { valid: false, reason: 'Formulaire rempli trop vite (' + decoded.d + 'ms)' };
        }
        if (typeof decoded.t === 'number' && Date.now() - decoded.t > 2 * 60 * 60 * 1000) {
            return { valid: false, reason: 'Token expire' };
        }
        return { valid: true };
    } catch {
        return { valid: false, reason: 'Token malforme' };
    }
}

async function checkRateLimit(email) {
    try {
        const oneHourAgo = Date.now() - (60 * 60 * 1000);
        const count      = await wixData.query(COLLECTION)
            .eq('clientEmail', email.toLowerCase())
            .gt('createdAtMs', oneHourAgo)
            .count({ suppressAuth: true });

        if (count >= MAX_BOOKINGS_PER_HOUR) {
            return { allowed: false, error: 'Trop de demandes. Veuillez patienter avant de reessayer.' };
        }
        return { allowed: true };
    } catch (e) {
        console.warn('Rate limit check echoue (non bloquant):', e.message);
        return { allowed: true };
    }
}

async function checkDuplicate(email, suiteKey, checkinISO) {
    try {
        const existing = await wixData.query(COLLECTION)
            .eq('clientEmail', email.toLowerCase())
            .eq('suiteKey',    suiteKey.toLowerCase())
            .eq('checkinIso',  checkinISO)
            .ne('status',      'cancelled')
            .limit(1)
            .find({ suppressAuth: true });

        return existing.items.length > 0;
    } catch (e) {
        console.warn('Duplicate check echoue (non bloquant):', e.message);
        return false;
    }
}

async function findOrCreateContact(clientName, clientEmail, phone) {
    try {
        const queryResult = await contacts.queryContacts()
            .eq('primaryInfo.email', clientEmail.toLowerCase())
            .limit(1)
            .find({ suppressAuth: true });

        if (queryResult.items.length > 0) {
            return queryResult.items[0]._id;
        }

        const nameParts = clientName.trim().split(' ');
        const created   = await contacts.createContact({
            name:   { first: nameParts[0] || clientName, last: nameParts.slice(1).join(' ') || '' },
            emails: [{ email: clientEmail.toLowerCase(), tag: 'MAIN' }],
            phones: [{ phone, tag: 'MOBILE' }]
        }, { suppressAuth: true });

        return created._id;
    } catch (e) {
        console.warn('findOrCreateContact echoue:', e.message);
        return null;
    }
}

async function sendEmails(item) {
    let ownerContactId = null;
    try {
        ownerContactId = await getSecret('OWNER_CONTACT_ID');
    } catch (e) {
        console.error('Secret OWNER_CONTACT_ID introuvable:', e.message);
    }

    // Email client
    try {
        const contactId = await findOrCreateContact(item.clientName, item.clientEmail, item.phone);
        if (contactId) {
            await triggeredEmails.emailContact('V1na0kD', contactId, {
                variables: {
                    suite:       item.suiteName,
                    checkin:     item.checkinFormatted,
                    checkout:    item.checkoutFormatted,
                    nights:      String(item.nights),
                    guests:      String(item.guests),
                    total:       String(item.total) + 'EUR',
                    clientName:  item.clientName,
                    clientEmail: item.clientEmail,
                    phone:       item.phone,
                    message:     item.message || 'Aucun message',
                    SITE_URL:    'https://www.loveroomvar.fr'
                }
            });
            console.log('Email client envoye');
        }
    } catch (e) {
        console.error('Email client echoue:', e.message);
    }

    // Email proprietaire
    if (ownerContactId) {
        try {
            await triggeredEmails.emailContact('V1nZ9s9', ownerContactId, {
                variables: {
                    clientName: item.clientName,
                    suite:      item.suiteName,
                    checkin:    item.checkinFormatted,
                    checkout:   item.checkoutFormatted,
                    nights:     String(item.nights),
                    guests:     String(item.guests),
                    total:      String(item.total) + 'EUR'
                }
            });
            console.log('Email proprietaire envoye');
        } catch (e) {
            console.error('Email proprietaire echoue:', e.message);
        }
    }
}

export const sendBookingConfirmation = webMethod(
    Permissions.Anyone,
    async (payload = {}) => {
        try {
            console.log('[bookings.web] Nouvelle demande recue');

            // 1. Anti-bot
            const secCheck = verifySecurityToken(payload._securityToken);
            if (!secCheck.valid) {
                console.warn('Bot detecte:', secCheck.reason);
                return { success: true, id: 'blocked' };
            }

            // 2. Extraction
            const checkinISO  = payload.checkinISO  || payload.checkinIso  || '';
            const checkoutISO = payload.checkoutISO || payload.checkoutIso || '';
            const {
                suiteKey = '', suite = '',
                nights = 0, guests = 2, total = 0,
                clientName = '', clientEmail = '', phone = '', message = '',
                weekendNights = 0, weekdayNights = 0,
                baseTotal = 0, optionsTotal = 0,
                priceBreakdown = '', options = ''
            } = payload;

            // 3. Whitelist suite
            if (!isValidSuiteKey(suiteKey)) {
                console.warn('Suite invalide:', suiteKey);
                return { success: false, error: 'Suite non reconnue.' };
            }

            // 4. Validations
            if (!suite) return { success: false, error: 'Suite non specifiee.' };
            if (!isISODate(checkinISO))  return { success: false, error: "Date d arrivee invalide." };
            if (!isISODate(checkoutISO)) return { success: false, error: 'Date de depart invalide.' };
            if (checkoutISO <= checkinISO)
                return { success: false, error: "La date de depart doit etre apres l arrivee." };

            const diffDays = (new Date(checkoutISO) - new Date(checkinISO)) / 86400000;
            if (diffDays < 1 || diffDays > 30)
                return { success: false, error: 'Duree invalide (1-30 nuits).' };

            // Date dans le passé ? (calculée dans le fuseau de l'établissement, pas en UTC)
            const today = todayISOInTimezone();
            if (checkinISO < today)
                return { success: false, error: "La date d arrivee ne peut pas etre dans le passe." };
            if (sanitizeText(clientName, 200).length < 3)
                return { success: false, error: 'Nom invalide (minimum 3 caracteres).' };
            if (!isValidEmail(clientEmail))
                return { success: false, error: 'Adresse email invalide.' };
            if (!isValidPhone(phone))
                return { success: false, error: 'Numero de telephone invalide.' };

            // 5. Rate limiting
            const rateCheck = await checkRateLimit(clientEmail);
            if (!rateCheck.allowed) return { success: false, error: rateCheck.error };

            // 6. Doublon
            const isDuplicate = await checkDuplicate(clientEmail, suiteKey, checkinISO);
            if (isDuplicate) {
                console.warn('Doublon detecte:', clientEmail, suiteKey, checkinISO);
                return { success: true, id: 'duplicate' };
            }

            // 7. Préparer les données
            const optionsSerialized = typeof options === 'string'
                ? options
                : (options ? JSON.stringify(options) : '');

            const item = {
                suiteKey:          suiteKey.toLowerCase(),
                suiteName:         sanitizeText(suite, 100),
                checkinIso:        checkinISO,
                checkoutIso:       checkoutISO,
                checkinFormatted:  formatDateFR(checkinISO),
                checkoutFormatted: formatDateFR(checkoutISO),
                nights:            Math.min(Number(nights) || 1, 30),
                weekendNights:     Number(weekendNights) || 0,
                weekdayNights:     Number(weekdayNights) || 0,
                // CORRECTION : plafond de voyageurs propre à chaque suite (Anayah = 4
                // confirmé ; les autres suites utilisent un garde-fou générique tant que
                // leurs vraies capacités ne sont pas précisées dans SUITE_MAX_GUESTS).
                guests:            Math.min(Math.max(Number(guests) || 2, 1), maxGuestsForSuite(suiteKey)),
                baseTotal:         Number(baseTotal)    || 0,
                optionsTotal:      Number(optionsTotal) || 0,
                total:             Number(total)        || 0,
                priceBreakdown:    sanitizeText(priceBreakdown, 500),
                options:           optionsSerialized,
                optionsDetail:     formatOptionsDetail(optionsSerialized),
                clientName:        sanitizeText(clientName, 200),
                clientEmail:       clientEmail.trim().toLowerCase(),
                phone:             sanitizeText(phone, 30),
                message:           sanitizeText(message, 2000),
                createdAtMs:       Date.now(),
                status:            'pending'
            };
            item.recapText = buildRecapText(item);

            // 8. Sauvegarde
            const inserted = await wixData.insert(COLLECTION, item, { suppressAuth: true });
            console.log('Reservation inseree:', inserted._id);

            // 9. Emails (non bloquants)
            sendEmails(item).catch(e => console.error('sendEmails error:', e.message));

            return { success: true, id: inserted._id };

        } catch (e) {
            console.error('[sendBookingConfirmation] Erreur:', e.message);
            return { success: false, error: 'Erreur serveur. Veuillez reessayer.' };
        }
    }
);
