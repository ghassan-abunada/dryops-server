"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONTENTS_REPORT_KINDS = void 0;
exports.emptyInitialWalk = emptyInitialWalk;
exports.emptyPackOut = emptyPackOut;
exports.emptyPackBack = emptyPackBack;
exports.emptyContentsReport = emptyContentsReport;
exports.normalizeContentsReport = normalizeContentsReport;
exports.contentsReportMissing = contentsReportMissing;
exports.isContentsReportComplete = isContentsReportComplete;
exports.shortDay = shortDay;
exports.clock = clock;
exports.summarizeContentsReport = summarizeContentsReport;
exports.contentsReportLine = contentsReportLine;
exports.CONTENTS_REPORT_KINDS = ['initial_walk', 'pack_out', 'pack_back'];
const SERVICE_LABEL = { offsite: 'Offsite storage', manipulation: 'Content manipulation', both: 'Offsite storage + manipulation' };
const AUTH_LABEL = { signed: 'Signed', sent: 'Sent for signature', not_signed: 'Not signed' };
const str = (v, max = 500) => (v === undefined || v === null ? '' : String(v)).trim().slice(0, max);
const bool = (v) => (v === true ? true : v === false ? false : null);
const int = (v, min, max) => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    return Number.isFinite(n) && Math.round(n) >= min && Math.round(n) <= max ? Math.round(n) : null;
};
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);
function emptyInitialWalk(prefill) {
    return {
        service: prefill?.service === 'offsite' || prefill?.service === 'manipulation' || prefill?.service === 'both' ? prefill.service : null,
        rooms: (prefill?.rooms ?? []).map(name => ({ name, wide_photo: false })),
        insurance: {
            not_insurance: !!prefill?.not_insurance,
            carrier: str(prefill?.carrier), claim_number: str(prefill?.claim_number),
            adjuster_name: str(prefill?.adjuster_name), adjuster_phone: str(prefill?.adjuster_phone), adjuster_email: str(prefill?.adjuster_email),
        },
        work_auth: { status: null, reason: '' },
        vault_estimate: null,
        packout: { scheduled: null, date: '', start_min: null, end_min: null, reason: '' },
        notes: '',
    };
}
function emptyPackOut() {
    return { techs_on_site: null, destination: null, vault_ids: [], vault_count: null, photos_taken: null, inventory_done: null, notes: '' };
}
function emptyPackBack() {
    return { techs_on_site: null, everything_returned: null, remaining: '', photos_taken: null, notes: '' };
}
function emptyContentsReport(kind) {
    return kind === 'initial_walk' ? emptyInitialWalk() : kind === 'pack_out' ? emptyPackOut() : emptyPackBack();
}
/** Clean an untrusted report into its shape (never throws). */
function normalizeContentsReport(kind, raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    if (kind === 'initial_walk') {
        const ins = r.insurance && typeof r.insurance === 'object' ? r.insurance : {};
        const wa = r.work_auth && typeof r.work_auth === 'object' ? r.work_auth : {};
        const po = r.packout && typeof r.packout === 'object' ? r.packout : {};
        const seen = new Set();
        const rooms = [];
        for (const x of Array.isArray(r.rooms) ? r.rooms : []) {
            const name = str(x && x.name, 60);
            const key = name.toLowerCase();
            if (!name || seen.has(key))
                continue;
            seen.add(key);
            const notes = str(x && x.notes, 300);
            rooms.push(notes ? { name, wide_photo: x.wide_photo === true, notes } : { name, wide_photo: x.wide_photo === true });
            if (rooms.length >= 40)
                break;
        }
        const service = r.service === 'offsite' || r.service === 'manipulation' || r.service === 'both' ? r.service : null;
        const status = wa.status === 'signed' || wa.status === 'sent' || wa.status === 'not_signed' ? wa.status : null;
        const start = int(po.start_min, 0, 1439);
        const end = int(po.end_min, 1, 1440);
        return {
            service, rooms,
            insurance: {
                not_insurance: ins.not_insurance === true,
                carrier: str(ins.carrier, 120), claim_number: str(ins.claim_number, 80),
                adjuster_name: str(ins.adjuster_name, 120), adjuster_phone: str(ins.adjuster_phone, 40), adjuster_email: str(ins.adjuster_email, 160),
            },
            work_auth: { status, reason: str(wa.reason, 300) },
            vault_estimate: service === 'manipulation' ? null : int(r.vault_estimate, 0, 500),
            packout: {
                scheduled: bool(po.scheduled),
                date: isDate(str(po.date, 10)) ? str(po.date, 10) : '',
                start_min: start, end_min: start !== null && end !== null && end > start ? end : null,
                reason: str(po.reason, 300),
            },
            notes: str(r.notes, 2000),
        };
    }
    if (kind === 'pack_out') {
        const d = r.destination && typeof r.destination === 'object' ? r.destination : null;
        let destination = null;
        if (d && d.kind === 'warehouse' && str(d.warehouse_id, 60)) {
            destination = { kind: 'warehouse', warehouse_id: str(d.warehouse_id, 60), warehouse_name: str(d.warehouse_name, 120), vault_labels: (Array.isArray(d.vault_labels) ? d.vault_labels : []).map((x) => str(x, 40)).filter(Boolean).slice(0, 200) };
        }
        else if (d && d.kind === 'unit') {
            destination = { kind: 'unit', facility: str(d.facility, 160), unit: str(d.unit, 40), access: str(d.access, 200) };
        }
        const labels = destination && destination.kind === 'warehouse' ? destination.vault_labels.length : 0;
        return {
            techs_on_site: int(r.techs_on_site, 1, 40),
            destination,
            vault_ids: destination && destination.kind === 'warehouse' ? (Array.isArray(r.vault_ids) ? r.vault_ids : []).map((x) => str(x, 60)).filter(Boolean).slice(0, 200) : [],
            // Picked vaults speak for themselves; a typed count is for a storage unit or a warehouse with no vault list yet.
            vault_count: labels > 0 ? labels : int(r.vault_count, 0, 500),
            photos_taken: bool(r.photos_taken),
            inventory_done: bool(r.inventory_done),
            notes: str(r.notes, 2000),
        };
    }
    return {
        techs_on_site: int(r.techs_on_site, 1, 40),
        everything_returned: bool(r.everything_returned),
        remaining: str(r.remaining, 500),
        photos_taken: bool(r.photos_taken),
        notes: str(r.notes, 2000),
    };
}
/** What is still unanswered, in the order the form asks it. Empty = ready to submit. */
function contentsReportMissing(kind, raw) {
    const out = [];
    if (kind === 'initial_walk') {
        const r = normalizeContentsReport(kind, raw);
        if (!r.service)
            out.push('Offsite storage or manipulation');
        if (!r.rooms.length)
            out.push('Rooms to pack');
        if (!r.insurance.not_insurance) {
            if (!r.insurance.carrier)
                out.push('Insurance carrier');
            if (!r.insurance.claim_number)
                out.push('Claim number');
        }
        if (!r.work_auth.status)
            out.push('Work authorization');
        else if (r.work_auth.status === 'not_signed' && !r.work_auth.reason)
            out.push('Why the work authorization is not signed');
        if (r.packout.scheduled === null)
            out.push('Pack-out scheduled');
        else if (r.packout.scheduled && !r.packout.date)
            out.push('Pack-out date');
        else if (!r.packout.scheduled && !r.packout.reason)
            out.push('Why the pack-out is not scheduled');
        return out;
    }
    if (kind === 'pack_out') {
        const r = normalizeContentsReport(kind, raw);
        if (r.techs_on_site === null)
            out.push('Technicians on site');
        if (!r.destination)
            out.push('Where the belongings went');
        else if (r.destination.kind === 'unit') {
            if (!r.destination.facility)
                out.push('Storage facility');
            if (!r.destination.unit)
                out.push('Unit number');
        }
        if (r.vault_count === null)
            out.push(r.destination && r.destination.kind === 'unit' ? 'How many vaults or loads' : 'Vaults used');
        if (r.photos_taken === null)
            out.push('Photos taken');
        if (r.inventory_done === null)
            out.push('Inventory done');
        return out;
    }
    const r = normalizeContentsReport(kind, raw);
    if (r.techs_on_site === null)
        out.push('Technicians on site');
    if (r.everything_returned === null)
        out.push('Everything returned');
    else if (!r.everything_returned && !r.remaining)
        out.push('What is still in storage');
    if (r.photos_taken === null)
        out.push('Photos taken');
    return out;
}
function isContentsReportComplete(kind, raw) {
    return contentsReportMissing(kind, raw).length === 0;
}
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** "2026-11-16" → "Mon 11/16" (calendar date, no time zone). */
function shortDay(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m)
        return iso;
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return `${DOW[d.getUTCDay()]} ${Number(m[2])}/${Number(m[3])}`;
}
/** 480 → "8am", 510 → "8:30am", 780 → "1pm". */
function clock(min) {
    const h24 = Math.floor(min / 60) % 24;
    const mm = min % 60;
    const h = h24 % 12 === 0 ? 12 : h24 % 12;
    return `${h}${mm ? `:${String(mm).padStart(2, '0')}` : ''}${h24 < 12 ? 'am' : 'pm'}`;
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
/** The report as the JobNimbus note reads it (and the visit's summary in the app). */
function summarizeContentsReport(kind, raw) {
    const lines = [];
    if (kind === 'initial_walk') {
        const r = normalizeContentsReport(kind, raw);
        lines.push('Initial walk report');
        lines.push(`Service: ${r.service ? SERVICE_LABEL[r.service] : 'not decided'}`);
        lines.push(r.rooms.length ? `Rooms to pack (${r.rooms.length}): ${r.rooms.map(x => x.name).join(', ')}` : 'Rooms to pack: none listed');
        if (r.rooms.length) {
            const wide = r.rooms.filter(x => x.wide_photo).length;
            const missing = r.rooms.filter(x => !x.wide_photo).map(x => x.name);
            lines.push(`Wide photos: ${wide} of ${r.rooms.length} rooms${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
        }
        for (const x of r.rooms)
            if (x.notes)
                lines.push(`${x.name}: ${x.notes}`);
        if (r.insurance.not_insurance)
            lines.push('Insurance: not an insurance job');
        else {
            const bits = [r.insurance.carrier || 'carrier missing', r.insurance.claim_number ? `claim ${r.insurance.claim_number}` : 'claim # missing'];
            if (r.insurance.adjuster_name)
                bits.push(`adjuster ${r.insurance.adjuster_name}`);
            lines.push(`Insurance: ${bits.join(' · ')}`);
        }
        lines.push(`Work authorization: ${r.work_auth.status ? AUTH_LABEL[r.work_auth.status] : 'not answered'}${r.work_auth.status === 'not_signed' && r.work_auth.reason ? ` (${r.work_auth.reason})` : ''}`);
        if (r.vault_estimate !== null)
            lines.push(`Vault estimate: ${r.vault_estimate}`);
        if (r.packout.scheduled === true) {
            const win = r.packout.start_min !== null && r.packout.end_min !== null ? `, ${clock(r.packout.start_min)}–${clock(r.packout.end_min)}` : '';
            lines.push(`${r.service === 'manipulation' ? 'Manipulation' : 'Pack-out'}: scheduled ${r.packout.date ? shortDay(r.packout.date) : 'date missing'}${win}`);
        }
        else if (r.packout.scheduled === false)
            lines.push(`${r.service === 'manipulation' ? 'Manipulation' : 'Pack-out'}: not scheduled yet${r.packout.reason ? ` (${r.packout.reason})` : ''}`);
        if (r.notes)
            lines.push(`Notes: ${r.notes}`);
        return lines.join('\n');
    }
    if (kind === 'pack_out') {
        const r = normalizeContentsReport(kind, raw);
        lines.push('Pack-out report');
        if (r.techs_on_site !== null)
            lines.push(`Technicians on site: ${r.techs_on_site}`);
        if (r.destination && r.destination.kind === 'warehouse') {
            lines.push(`Stored at: ${r.destination.warehouse_name || 'the warehouse'}`);
            if (r.destination.vault_labels.length)
                lines.push(`Vaults (${r.destination.vault_labels.length}): ${r.destination.vault_labels.join(', ')}`);
            else if (r.vault_count !== null)
                lines.push(`Vaults: ${r.vault_count}`);
        }
        else if (r.destination && r.destination.kind === 'unit') {
            lines.push(`Stored at: ${[r.destination.facility || 'storage unit', r.destination.unit ? `unit ${r.destination.unit}` : ''].filter(Boolean).join(', ')}`);
            if (r.destination.access)
                lines.push(`Access: ${r.destination.access}`);
            if (r.vault_count !== null)
                lines.push(`Vaults / loads: ${r.vault_count}`);
        }
        else
            lines.push('Stored at: not recorded');
        if (r.photos_taken !== null)
            lines.push(`Photos taken: ${r.photos_taken ? 'Yes' : 'No'}`);
        if (r.inventory_done !== null)
            lines.push(`Inventory done: ${r.inventory_done ? 'Yes' : 'No'}`);
        if (r.notes)
            lines.push(`Notes: ${r.notes}`);
        return lines.join('\n');
    }
    const r = normalizeContentsReport(kind, raw);
    lines.push('Pack-back report');
    if (r.techs_on_site !== null)
        lines.push(`Technicians on site: ${r.techs_on_site}`);
    if (r.everything_returned !== null)
        lines.push(r.everything_returned ? 'Everything returned: Yes' : `Everything returned: No${r.remaining ? ` (still in storage: ${r.remaining})` : ''}`);
    if (r.photos_taken !== null)
        lines.push(`Photos taken: ${r.photos_taken ? 'Yes' : 'No'}`);
    if (r.notes)
        lines.push(`Notes: ${r.notes}`);
    return lines.join('\n');
}
/** One line for a visit card: "Offsite · 3 rooms · packout Mon 11/16" / "4 vaults · Fort Worth warehouse". */
function contentsReportLine(kind, raw) {
    if (kind === 'initial_walk') {
        const r = normalizeContentsReport(kind, raw);
        return [
            r.service ? (r.service === 'manipulation' ? 'Manipulation' : r.service === 'both' ? 'Offsite + manipulation' : 'Offsite') : null,
            r.rooms.length ? plural(r.rooms.length, 'room', 'rooms') : null,
            r.packout.scheduled && r.packout.date ? `${r.service === 'manipulation' ? 'manipulation' : 'pack-out'} ${shortDay(r.packout.date)}` : r.packout.scheduled === false ? 'not scheduled' : null,
        ].filter(Boolean).join(' · ');
    }
    if (kind === 'pack_out') {
        const r = normalizeContentsReport(kind, raw);
        return [
            r.vault_count !== null ? plural(r.vault_count, 'vault', 'vaults') : null,
            r.destination ? (r.destination.kind === 'warehouse' ? r.destination.warehouse_name || 'warehouse' : r.destination.facility || 'storage unit') : null,
        ].filter(Boolean).join(' · ');
    }
    const r = normalizeContentsReport(kind, raw);
    return r.everything_returned === null ? '' : r.everything_returned ? 'Everything returned' : 'Some items still in storage';
}
