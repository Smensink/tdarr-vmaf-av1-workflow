"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;

// Compatibility tombstone for the obsolete plural payload. Its writer expected
// vmafBestParameters to contain { parameterSet, avgVMAF }, while the current
// selector publishes the parameter set directly. Keeping the old writer
// available would therefore emit misleading empty-CQ training rows.
var details = function () { return ({
    name: '[Retired] Learn CQ Ranges',
    description: 'Retired compatibility payload. Use Learn CQ Range; this node never writes training state.',
    style: { borderColor: 'grey' },
    tags: 'video,vmaf,learning,retired',
    isStartPlugin: false,
    pType: '',
    requiresVersion: '2.11.01',
    sidebarPosition: -1,
    icon: 'faBan',
    inputs: [],
    outputs: [
        { number: 1, tooltip: 'Unused compatibility output.' },
        { number: 2, tooltip: 'Retired; no learning state was written.' },
    ],
}); };
exports.details = details;

var plugin = function (args) {
    args.variables = args.variables || {};
    args.variables.vmafLearnCQRangesRetired = true;
    args.jobLog('RETIRED: Learn CQ Ranges is incompatible with the current selector shape and wrote no training state. Replace it with Learn CQ Range.');
    return {
        outputFileObj: args.inputFileObj,
        outputNumber: 2,
        variables: args.variables,
    };
};
exports.plugin = plugin;
