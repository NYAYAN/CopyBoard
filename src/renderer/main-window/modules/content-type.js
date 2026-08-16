// ES-module face of ../../shared/content-type.js.
//
// The classification itself lives in a classic script because three windows render rows of
// clipboard entries — this list, the widget's panel and the quick-paste picker — and only
// this one is built from modules. Rather than keep two copies in step, the shared script
// attaches its exports to a global and this file hands them to module code under normal
// import syntax.
const C = window.CopyBoardContent;

export const classify = C.classify;
export const cssColor = C.cssColor;
export const MONO_TYPES = C.MONO_TYPES;
export const iconFor = C.iconFor;
export const previewText = C.previewText;
export const clip = C.clip;
export const groupKey = C.groupKey;
export const GROUP_LABELS = C.GROUP_LABELS;
export const shortTime = C.shortTime;
export const fullTime = C.fullTime;
