// Groups a team's roster by specific position (QB, RB, WR, TE, OL / DL,
// LB, CB, S / K, P, LS) for TeamDetailPage's depth-chart-style layout
// (2026-09-15) -- closer to how ESPN's depth chart reads than the
// coarse offense/defense/special_teams split constants/positionGroups.js
// exists for (that file's own Player Browse filter dropdown stays as-is
// -- this is additive, not a replacement).
//
// RAW_TO_BUCKET mirrors worker/ingestion-worker.js's own POSITION_GROUP
// sets exactly, just split one level finer (that file only needs
// offense/defense/special_teams; this page wants the position-group-
// within-a-position-group breakdown). rosterBucketFor() falls back to
// the raw position itself as its own single-player bucket for anything
// not in the map, rather than silently dropping a player whose position
// code this list hasn't seen yet.

export const ROSTER_POSITION_ORDER = ['QB', 'RB', 'WR', 'TE', 'OL', 'DL', 'LB', 'CB', 'S', 'K', 'P', 'LS'];

export const ROSTER_POSITION_LABEL = {
  QB: 'Quarterbacks',
  RB: 'Running Backs',
  WR: 'Wide Receivers',
  TE: 'Tight Ends',
  OL: 'Offensive Line',
  DL: 'Defensive Line',
  LB: 'Linebackers',
  CB: 'Cornerbacks',
  S: 'Safeties',
  K: 'Kickers',
  P: 'Punters',
  LS: 'Long Snappers',
};

const RAW_TO_BUCKET = {
  QB: 'QB',
  RB: 'RB',
  FB: 'RB',
  HB: 'RB',
  WR: 'WR',
  TE: 'TE',
  T: 'OL',
  G: 'OL',
  C: 'OL',
  OT: 'OL',
  OG: 'OL',
  OL: 'OL',
  DE: 'DL',
  DT: 'DL',
  NT: 'DL',
  DL: 'DL',
  EDGE: 'DL',
  LB: 'LB',
  ILB: 'LB',
  OLB: 'LB',
  MLB: 'LB',
  CB: 'CB',
  DB: 'CB',
  NB: 'CB',
  S: 'S',
  SS: 'S',
  FS: 'S',
  SAF: 'S',
  K: 'K',
  KR: 'K',
  PR: 'K',
  P: 'P',
  LS: 'LS',
};

export function rosterBucketFor(position) {
  const pos = (position || '').toUpperCase();
  return RAW_TO_BUCKET[pos] ?? pos;
}
