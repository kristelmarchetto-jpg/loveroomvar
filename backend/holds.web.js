// backend/holds.web.js
// ═══════════════════════════════════════════════════════════════
// 🔒 SÉCURITÉ MAX :
//   - Max 3 holds actifs par suite (anti-flooding, non contournable par IP)
//   - Max 5 holds par IP par heure (anti-abus, best-effort — voir note IP)
//   - Token cryptographiquement fort (crypto.randomBytes, CSPRNG)
//   - Validation stricte des entrées
//   - Nettoyage automatique des holds expirés
//   - Anti-double-réservation par chevauchement de dates (pas seulement
//     égalité exacte de startISO), avec réconciliation post-insertion
//     pour fermer la fenêtre de race condition (voir createHold).
//
// ✅ CORRECTION : 'anayah' ajouté à isValidSuiteKey (était absent → les holds
//    Anayah échouaient avec "Suite inconnue"). Anayah a maintenant la même
//    protection anti-double-réservation que les autres suites.
//
// ⚠️ NOTE IP : `context` (dernier paramètre injecté par Velo sur les
//    webMethod) est sondé pour une IP côté serveur via plusieurs noms
//    d'accesseurs possibles (l'API exacte dépend de la version de Velo et
//    n'a pas pu être confirmée depuis cet environnement). Si aucun ne
//    répond, on retombe sur l'IP envoyée par le client, qui reste
//    falsifiable. Dans ce cas, la vraie protection anti-abus repose sur
//    MAX_HOLDS_PER_SUITE (basé sur la suite, pas sur l'IP, donc non
//    contournable de cette façon). Si `extractServerIp` ne trouve jamais
//    rien dans vos logs, envisagez de déplacer cet endpoint vers une
//    HTTP Function (`src/backend/http-functions.js`), où `request.ip`
//    est documenté de façon fiable.
// ═══════════════════════════════════════════════════════════════

import wixData from 'wix-data';
import { webMethod, Permissions } from 'wix-web-module';
import crypto from 'crypto';

const COLLECTION        = 'BookingHolds';
const HOLD_DURATION_MS  = 15 * 60 * 1000;      // 15 min
const HOLD_EXTENDED_MS  =  6 * 60 * 60 * 1000; // 6h après confirmation
const MAX_HOLDS_PER_SUITE = 3;                  // Max holds actifs par suite
const MAX_HOLDS_PER_IP    = 5;                  // Max holds par IP par heure
const TIMEZONE            = 'Europe/Paris';     // ⚠️ à ajuster si l'établissement n'est pas en France

// ─── TOKEN FORT ────────────────────────────────────────────────

function generateToken() {
    // CSPRNG (Node crypto), 32 octets = 256 bits d'entropie encodés en hex.
    return crypto.randomBytes(32).toString('hex');
}

// ─── VALIDATION ────────────────────────────────────────────────

function isISODate(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isValidSuiteKey(s) {
    // ✅ Les 5 suites sont acceptées (anayah était manquante avant).
    //    Milovat et Anayah sont gérées "site uniquement" mais gardent
    //    la protection hold anti-double-réservation.
    return ['arcadie', 'ecrin', 'milovat', 'boreal', 'anayah'].includes(
        (s || '').toLowerCase()
    );
}

function todayISOInTimezone(timeZone = TIMEZONE) {
    // Locale en-CA -> format YYYY-MM-DD directement, dans le fuseau donné
    // (évite le bug "today" calculé en UTC qui décale la date proche de minuit).
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
}

function rangesOverlap(startA, endA, startB, endB) {
    // Chevauchement de deux plages [start, end) au format ISO (comparaison
    // lexicographique valide pour des dates YYYY-MM-DD).
    return startA < endB && startB < endA;
}

function extractServerIp(context) {
    if (!context) return null;
    try {
        if (typeof context.getRemoteIp === 'function') return context.getRemoteIp();
        if (typeof context.getIp === 'function')        return context.getIp();
        if (typeof context.ip === 'string')              return context.ip;
    } catch (e) {
        console.warn('extractServerIp error (non bloquant):', e.message);
    }
    return null;
}

// ─── ANTI-FLOODING : holds actifs par suite ────────────────────

async function countActiveHoldsForSuite(suiteKey) {
    try {
        const now      = Date.now();
        const existing = await wixData.query(COLLECTION)
            .eq('suiteKey', suiteKey.toLowerCase())
            .descending('createdAtMs')
            .limit(50)
            .find({ suppressAuth: true });

        return existing.items.filter(h =>
            h.status !== 'released' &&
            h.status !== 'confirmed' &&
            h.expiresAtMs > now
        ).length;
    } catch (e) {
        console.warn('countActiveHolds error (non bloquant):', e.message);
        return 0;
    }
}

// ─── RATE LIMIT : holds par IP ─────────────────────────────────

async function countRecentHoldsByIp(clientIp) {
    if (!clientIp || clientIp === 'unknown') return 0;
    try {
        const oneHourAgo = Date.now() - (60 * 60 * 1000);
        const existing   = await wixData.query(COLLECTION)
            .eq('clientIp', clientIp)
            .descending('createdAtMs')
            .limit(50)
            .find({ suppressAuth: true });

        return existing.items.filter(h => h.createdAtMs > oneHourAgo).length;
    } catch (e) {
        console.warn('countRecentHoldsByIp error (non bloquant):', e.message);
        return 0;
    }
}

// ─── CONFLITS : holds actifs chevauchant une plage de dates ────

async function findOverlappingActiveHolds(suiteKey, startISO, endISO, now = Date.now()) {
    const existing = await wixData.query(COLLECTION)
        .eq('suiteKey', suiteKey.toLowerCase())
        .descending('createdAtMs')
        .limit(100)
        .find({ suppressAuth: true });

    return existing.items.filter(h =>
        h.status !== 'released' &&
        h.expiresAtMs > now &&
        rangesOverlap(startISO, endISO, h.startISO, h.endISO)
    );
}

// ─── NETTOYAGE HOLDS EXPIRÉS ───────────────────────────────────

async function cleanExpiredHolds() {
    try {
        const old = await wixData.query(COLLECTION)
            .lt('expiresAtMs', Date.now() - 60000) // expirés depuis > 1 min
            .limit(20)
            .find({ suppressAuth: true });

        if (old.items.length > 0) {
            await Promise.all(
                old.items.map(item =>
                    wixData.remove(COLLECTION, item._id, { suppressAuth: true }).catch(() => {})
                )
            );
            console.log(old.items.length + ' holds expirés nettoyés');
        }
    } catch (e) {
        console.warn('Nettoyage holds échoué (non critique):', e.message);
    }
}

// ═══════════════════════════════════════════════════════════════
// CRÉER UN HOLD
// ═══════════════════════════════════════════════════════════════

export const createHold = webMethod(
    Permissions.Anyone,
    async (suiteKey, startISO, endISO, clientIp = null, context) => {
        console.log('createHold:', suiteKey, startISO, '->', endISO);

        // ── Validation stricte ──
        if (!isValidSuiteKey(suiteKey)) {
            throw new Error('Suite inconnue: ' + suiteKey);
        }
        if (!isISODate(startISO) || !isISODate(endISO)) {
            throw new Error('Dates invalides');
        }
        if (endISO <= startISO) {
            throw new Error('endISO doit être après startISO');
        }

        // Date dans le passé ? (calculée dans le fuseau de l'établissement, pas en UTC)
        const today = todayISOInTimezone();
        if (startISO < today) {
            throw new Error('Date de début dans le passé');
        }

        // IP : on privilégie une IP dérivée côté serveur si le contexte Velo
        // l'expose ; sinon on retombe sur la valeur envoyée par le client
        // (falsifiable — voir note en tête de fichier).
        const serverIp   = extractServerIp(context);
        const resolvedIp = serverIp || clientIp || 'unknown';

        // Nettoyage non bloquant
        cleanExpiredHolds().catch(() => {});

        // ── Anti-flooding suite (non contournable par IP) ──
        const activeForSuite = await countActiveHoldsForSuite(suiteKey);
        if (activeForSuite >= MAX_HOLDS_PER_SUITE) {
            console.warn('Flooding détecté sur suite:', suiteKey, '(' + activeForSuite + ' holds actifs)');
            throw new Error('SUITE_BUSY');
        }

        // ── Rate limit IP ──
        if (resolvedIp !== 'unknown') {
            const recentByIp = await countRecentHoldsByIp(resolvedIp);
            if (recentByIp >= MAX_HOLDS_PER_IP) {
                console.warn('Rate limit IP atteint:', resolvedIp);
                throw new Error('RATE_LIMIT_IP');
            }
        }

        // ── Vérification conflit (chevauchement de dates), best-effort avant insertion ──
        try {
            const conflicts = await findOverlappingActiveHolds(suiteKey, startISO, endISO);
            if (conflicts.length > 0) {
                console.warn('Hold actif existant (chevauchement) pour', suiteKey, startISO, '-', endISO);
                throw new Error('HOLD_CONFLICT');
            }
        } catch (error) {
            if (error.message === 'HOLD_CONFLICT') throw error;
            console.warn('Vérif conflit échouée (non bloquant):', error.message);
        }

        // ── Créer le hold ──
        const token       = generateToken();
        const createdAtMs = Date.now();
        const expiresAtMs = createdAtMs + HOLD_DURATION_MS;

        const inserted = await wixData.insert(COLLECTION, {
            suiteKey:    suiteKey.toLowerCase(),
            startISO,
            endISO,
            token,
            expiresAtMs,
            createdAtMs,
            clientIp:    resolvedIp,
            status:      'active'
        }, { suppressAuth: true });

        // ── Réconciliation anti-course ──
        // Le check pré-insertion ci-dessus n'est pas atomique : deux requêtes
        // concurrentes peuvent toutes les deux le passer avant qu'aucune n'ait
        // inséré. On revérifie donc juste après l'insertion, et en cas de
        // holds concurrents chevauchants, un départage déterministe (le même
        // pour toutes les requêtes en course : createdAtMs puis _id) décide
        // qui gagne — le perdant s'auto-supprime et échoue proprement.
        // NB : poser un index unique (suiteKey+startISO ou une clé de plage)
        // côté Content Manager Wix Data fermerait complètement cette fenêtre
        // résiduelle ; à défaut, cette réconciliation la réduit au minimum.
        try {
            const postInsert     = await findOverlappingActiveHolds(suiteKey, startISO, endISO);
            const activeSiblings = postInsert.filter(h => h._id !== inserted._id);
            const lostRace       = activeSiblings.some(h =>
                h.createdAtMs < inserted.createdAtMs ||
                (h.createdAtMs === inserted.createdAtMs && h._id < inserted._id)
            );

            if (lostRace) {
                await wixData.remove(COLLECTION, inserted._id, { suppressAuth: true }).catch(() => {});
                console.warn('Course perdue sur', suiteKey, startISO, '-', endISO);
                throw new Error('HOLD_CONFLICT');
            }
        } catch (error) {
            if (error.message === 'HOLD_CONFLICT') throw error;
            console.warn('Réconciliation anti-course échouée (non bloquant):', error.message);
        }

        console.log('✅ Hold créé:', inserted._id);
        return {
            _id:       inserted._id,
            token,
            expiresAt: new Date(expiresAtMs).toISOString()
        };
    }
);

// ═══════════════════════════════════════════════════════════════
// VALIDER UN HOLD
// ═══════════════════════════════════════════════════════════════

export const validateHold = webMethod(
    Permissions.Anyone,
    async (holdId, token) => {
        if (!holdId || !token) return false;
        // Validation format holdId (évite injection)
        if (typeof holdId !== 'string' || holdId.length > 100) return false;
        if (typeof token  !== 'string' || token.length  > 100) return false;

        try {
            const hold = await wixData.get(COLLECTION, holdId, { suppressAuth: true });
            if (!hold)                         return false;
            if (hold.token !== token)          return false;
            if (hold.status === 'released')    return false;
            if (hold.expiresAtMs < Date.now()) return false;
            return true;
        } catch (e) {
            console.error('validateHold error:', e.message);
            return false;
        }
    }
);

// ═══════════════════════════════════════════════════════════════
// LIBÉRER UN HOLD
// ═══════════════════════════════════════════════════════════════

export const releaseHold = webMethod(
    Permissions.Anyone,
    async (holdId, token) => {
        if (!holdId || !token) return false;
        if (typeof holdId !== 'string' || holdId.length > 100) return false;
        if (typeof token  !== 'string' || token.length  > 100) return false;

        try {
            const hold = await wixData.get(COLLECTION, holdId, { suppressAuth: true });
            if (!hold || hold.token !== token) return false;

            await wixData.remove(COLLECTION, holdId, { suppressAuth: true });
            console.log('✅ Hold libéré:', holdId);
            return true;
        } catch (e) {
            console.error('releaseHold error:', e.message);
            return false;
        }
    }
);

// ═══════════════════════════════════════════════════════════════
// PROLONGER UN HOLD (après confirmation)
// ═══════════════════════════════════════════════════════════════

export const extendHold = webMethod(
    Permissions.Anyone,
    async (holdId, token) => {
        if (!holdId || !token) return false;
        if (typeof holdId !== 'string' || holdId.length > 100) return false;
        if (typeof token  !== 'string' || token.length  > 100) return false;

        try {
            const hold = await wixData.get(COLLECTION, holdId, { suppressAuth: true });
            if (!hold || hold.token !== token) return false;
            if (hold.status === 'released') {
                console.warn('Tentative extend sur hold released:', holdId);
                return false;
            }

            await wixData.update(COLLECTION, {
                ...hold,
                expiresAtMs: Date.now() + HOLD_EXTENDED_MS,
                status:      'confirmed'
            }, { suppressAuth: true });

            console.log('✅ Hold prolongé:', holdId);
            return true;
        } catch (e) {
            console.error('extendHold error:', e.message);
            return false;
        }
    }
);
