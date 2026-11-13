"use strict";
// Contents (packout) vocabulary shared by the job page, the visit reports, the
// review and the stats (owner 2026-11-13). Pure.
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONTENTS_SERVICE_LABELS = exports.CONTENTS_SERVICES = void 0;
exports.serviceLabel = serviceLabel;
exports.serviceCode = serviceCode;
exports.storageSold = storageSold;
exports.storageInfoLine = storageInfoLine;
exports.CONTENTS_SERVICES = [
    { key: 'offsite', label: 'Offsite storage', detail: 'Packed and taken to a warehouse or storage unit' },
    { key: 'manipulation', label: 'Manipulation', detail: 'Moved to another room, nothing leaves the site' },
    { key: 'both', label: 'Both', detail: 'Some rooms go to storage, some are moved on site' },
];
exports.CONTENTS_SERVICE_LABELS = exports.CONTENTS_SERVICES.map(s => s.label);
function serviceLabel(code) {
    return exports.CONTENTS_SERVICES.find(s => s.key === code)?.label ?? null;
}
function serviceCode(label) {
    return exports.CONTENTS_SERVICES.find(s => s.label === label)?.key ?? null;
}
/** Offsite storage was sold: the walk said so, or the job already shows belongings in storage. */
function storageSold(job) {
    return job.contents_service === 'offsite' || job.contents_service === 'both' || !!job.in_storage || (job.storage_vaults ?? 0) > 0;
}
/** One line for `jobs.storage_unit_info` and the JobNimbus "Storage unit info" field. */
function storageInfoLine(d) {
    if (d.kind === 'warehouse') {
        const vaults = d.vault_labels.length ? ` · vaults ${d.vault_labels.join(', ')}` : '';
        return `${d.warehouse_name}${vaults}`;
    }
    return [d.facility.trim(), d.unit.trim() ? `unit ${d.unit.trim()}` : '', d.access.trim()].filter(Boolean).join(' · ');
}
