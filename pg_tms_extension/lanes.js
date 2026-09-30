/**
 * P&G contracted lanes (generated from the SMC "Matching contracts" export).
 * One entry per origin→destination, keyed "<ORIGIN_CODE>-><DEST_CODE>".
 * Used by the draft builder to default the LINE_HAUL price, equipment and
 * loading type, and to flag a load whose lane isn't contracted.
 *
 * Regenerate with _parse_lanes.mjs from a fresh export; do not hand-edit.
 * 57 lanes, 20 origin sites.
 */
export const LANES = {
  "_MAGNERA_16928_545->4853_CRA_74564_148": {"price":1.3,"currency":"EUR","equipment":"13.6m box megatrailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-08-18","validTo":"2027-08-01","maxPallets":250},
  "288_GROS_64521_903->MATARO_B_08302__850": {"price":2.51,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-08-01","validTo":"2027-08-01","maxPallets":200},
  "6415___J_03100_283->ZAZ1": {"price":478,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":50},
  "B145___L_19171_315->ZAZ1": {"price":380,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":28},
  "B145___L_19171_384->ZAZ8": {"price":380,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-09-03","validTo":"2027-07-01","maxPallets":250},
  "BIG_BOX_80000_398->BVA1": {"price":280,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":90},
  "BIG_BOX_80000_398->CDG7": {"price":295,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":100},
  "BIG_BOX_80000_398->ETZ2": {"price":450,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":150},
  "BIG_BOX_80000_398->LIL1": {"price":300,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":100},
  "BIG_BOX_80000_398->LYS1": {"price":815,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":50},
  "BIG_BOX_80000_398->PROCTER__53881_118": {"price":637,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":300},
  "BIG_BOX_80000_398->XCD2": {"price":300,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":100},
  "BIG_BOX_80000_398->XLY2": {"price":640,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-09-30","validTo":"2027-07-01","maxPallets":250},
  "CD_GROUP_26020__751->BLQ1": {"price":400,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":100},
  "CD_GROUP_26020__751->MXP6": {"price":263,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-08-03","validTo":"2027-08-01","maxPallets":150},
  "CD_GROUP_26020__751->TRN1": {"price":400,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":150},
  "CD_GROUP_26020__751->XLI3": {"price":263,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":100},
  "DHL_MATA_08302__956->RMU1": {"price":600,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-08-01","validTo":"2027-07-01","maxPallets":40},
  "DROP_826_97828_277->DTM1": {"price":518,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"DROP_HOOK","deliveryLoadingType":"DROP_HOOK","validFrom":"2026-08-27","validTo":"2027-07-01","maxPallets":41},
  "DROP_PRO_53881_589->HAM2": {"price":893,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"DROP_HOOK","deliveryLoadingType":"DROP_HOOK","validFrom":"2026-08-27","validTo":"2027-07-01","maxPallets":45},
  "DROPP_RO_RM20_4AL_622->EMA2": {"price":445,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"DROP_HOOK","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":46},
  "DROPP_RO_RM20_4AL_622->EMA3": {"price":510,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":10},
  "DROPP_RO_RM20_4AL_622->MAN1": {"price":774,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":10},
  "DROPP_RO_RM20_4AL_622->MAN3": {"price":1.06,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"DROP_HOOK","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":10},
  "DROPP_RO_RM20_4AL_622->XUKT": {"price":659.59,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"DROP_HOOK","deliveryLoadingType":"DROP_HOOK","validFrom":"2026-09-16","validTo":"2027-07-01","maxPallets":10},
  "ESCABANI_19171__208->SVQ1": {"price":726,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":50},
  "ESMEQUIN_50170_337->ZAZ8": {"price":380,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-09-03","validTo":"2027-07-01","maxPallets":100},
  "ITPOME_00071__764->FCO1": {"price":973,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":50},
  "OLGIATE_22077__477->CD_GROUP_26020__751": {"price":3,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-09-01","validTo":"2027-08-02","maxPallets":10},
  "P_G_GARW_08_400_885->PROCTER__41000_224": {"price":3.27,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-09-10","validTo":"2027-07-01","maxPallets":35},
  "P_G_MATA_03100__156->BCN1": {"price":714,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":50},
  "P_G_MATA_03100__156->MAD7": {"price":544,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":700},
  "PROCTER__53881_118->BVA1": {"price":1.07,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":295},
  "PROCTER__53881_118->CDG7": {"price":1.16,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":295},
  "PROCTER__53881_118->DTM1": {"price":470,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":100},
  "PROCTER__53881_118->DTM2": {"price":480,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":250},
  "PROCTER__53881_118->DTM5": {"price":480,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":250},
  "PROCTER__53881_118->ETZ2": {"price":621,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":100},
  "PROCTER__53881_118->HAJ1": {"price":536,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":241},
  "PROCTER__53881_118->LEJ1": {"price":971,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":191},
  "PROCTER__53881_118->LIL1": {"price":890,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":100},
  "PROCTER__53881_118->LYS1": {"price":1.53,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":20},
  "PROCTER__53881_118->ORY1": {"price":1.2,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":9},
  "PROCTER__53881_118->RLG1": {"price":1.36,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":150},
  "PROCTER__53881_118->XCD2": {"price":890,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":100},
  "PROCTER__53881_118->XCD7": {"price":1.75,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":10},
  "PROCTER__53881_118->XFK1": {"price":650,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":100},
  "PROCTER__53881_118->XLY2": {"price":650,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-09-04","validTo":"2027-07-01","maxPallets":250},
  "PROCTER__97828__849->CDG7": {"price":1.3,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":100},
  "PROCTER__97828__849->DTM2": {"price":509,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":50},
  "PROCTER__97828__849->ESCABANI_19171__208": {"price":2.89,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-08-01","validTo":"2027-07-01","maxPallets":350},
  "PROCTER__97828__849->LIL1": {"price":1.2,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":100},
  "PROCTER__97828__849->MRS1": {"price":1.71,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":10},
  "PROCTER__97828__849->STR4": {"price":470,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":100},
  "PROCTER__97828__849->XLY2": {"price":650,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"LIVE_LOAD","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-09-04","validTo":"2027-07-01","maxPallets":239},
  "PROCTOR__RM20_4AL_433->LBA2": {"price":350,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"DROP_HOOK","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":200},
  "PROCTOR__RM20_4AL_433->NCL1": {"price":266,"currency":"EUR","equipment":"Single Deck Trailer","freightType":"TRUCKLOAD","loadingType":"DROP_HOOK","deliveryLoadingType":"LIVE_LOAD","validFrom":"2026-07-01","validTo":"2027-07-01","maxPallets":10},
};

// SMC pickup location code → site key (derived from the lane origins).
export const ORIGIN_SITE = {
  "PROCTER__53881_118": "euskirchen",
  "DROP_PRO_53881_589": "euskirchen",
  "4830_P_G_53881_171": "euskirchen",
  "4830_P_G_53881_588": "euskirchen",
  "AMAZON_E_53881_468": "euskirchen",
  "PROCTER__97828__849": "altfeld",
  "DROP_826_97828_277": "altfeld",
  "4552_ALT_97828_513": "altfeld",
  "8268_ALT_97828_909": "altfeld",
  "BIG_BOX_80000_398": "amiens",
  "CIMAT_80013__487": "amiens",
  "4106_AMI_80013_110": "amiens",
  "FRCIMAT_80046_838": "amiens",
  "6415___J_03100_283": "jijona",
  "P_G_MATA_03100__156": "jijona",
  "PROCTER__74564__339": "jijona",
  "B145___L_19171_315": "cabanillas",
  "ESCABANI_19171__208": "cabanillas",
  "B145___L_19171_384": "cabanillas",
  "CD_GROUP_26020__751": "agnadello",
  "8486_STO_26020_132": "agnadello",
  "ITPOME_00071__764": "agnadello",
  "DROPP_RO_RM20_4AL_622": "london",
  "PROCTOR__RM20_4AL_433": "london"
};

export function findLane(origin, dest) {
  return LANES[`${origin}->${dest}`] || null;
}

// Destination node codes contracted from a given origin code, e.g. for
// resolving a TMS street address to a node by asking SMC for each candidate.
export function laneDestinations(origin) {
  const out = [];
  const prefix = origin + "->";
  for (const key of Object.keys(LANES)) if (key.startsWith(prefix)) out.push(key.slice(prefix.length));
  return out;
}
