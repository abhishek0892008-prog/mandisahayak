/**
 * Response fixtures.
 *
 * These are not invented shapes. Each one mirrors a response captured from the
 * running backend during the integration audit, so a test passing here means
 * the component handles what the server actually sends. If the contract
 * changes, these are the first things that must change with it.
 */

export const me = {
  userId: "b606db4b-27cf-4e6d-b1f3-4f3286b6ca6c",
  fullName: "Ramesh Kumar",
  phoneMasked: "***22",
  locale: "en",
  status: "ACTIVE",
  roles: ["FARMER"],
  permissions: [
    "booking.cancel.own",
    "booking.create.own",
    "booking.read.own",
    "notification.read.own",
    "notification.update.own",
    "payment.read.own",
    "procurement.read.own",
    "profile.read.own",
    "profile.update.own",
    "queue.read.own",
    "reference.read",
    "slot.query",
  ],
  district: { id: "44444444-0000-4000-a000-000000000012", name: "Agra" },
  village: null,
  centreIds: [],
};

export const districts = [
  {
    id: "44444444-0000-4000-a000-000000000012",
    name: "Agra",
    lgdCode: null,
    dataType: "CONFIGURED",
    state: { name: "Uttar Pradesh", lgdCode: "9" },
  },
  {
    id: "44444444-0000-4000-a000-000000000011",
    name: "Aligarh",
    lgdCode: null,
    dataType: "CONFIGURED",
    state: { name: "Uttar Pradesh", lgdCode: "9" },
  },
];

/**
 * `GET /reference/registration-centres?districtId=` — the PUBLIC, deliberately
 * narrow projection the officer application form uses. Captured verbatim from
 * the running backend: note `acceptedCrops` are {id, name} OBJECTS here, unlike
 * the plain crop-name strings on `centres` below (`/reference/centres`). The
 * crop dropdown is driven from this nested list, not from a separate request.
 */
export const registrationCentres = [
  {
    id: "55555555-0000-4000-a000-000000000001",
    code: "DEMO-UP-ALIGARH-01",
    name: "Aligarh Demonstration Procurement Centre",
    district: { id: "44444444-0000-4000-a000-000000000011", name: "Aligarh" },
    acceptedCrops: [
      { id: "c9422b7f-858f-4740-a964-780671c8ca4c", name: "Paddy" },
      { id: "a5ebf3f4-c6d4-438a-b5dc-4ee4f06ef5a2", name: "Wheat" },
    ],
  },
];

/** Agra's centre accepts Wheat only — the contrast that exposes a stale crop. */
export const registrationCentresAgra = [
  {
    id: "55555555-0000-4000-a000-000000000002",
    code: "DEMO-UP-AGRA-01",
    name: "Agra Demonstration Procurement Centre",
    district: { id: "44444444-0000-4000-a000-000000000012", name: "Agra" },
    acceptedCrops: [{ id: "a5ebf3f4-c6d4-438a-b5dc-4ee4f06ef5a2", name: "Wheat" }],
  },
];

/** Village data is genuinely unavailable; this is a 200, not an error. */
export const villagesUnavailable = {
  districtId: "44444444-0000-4000-a000-000000000012",
  available: false,
  reasonCode: "NO_VILLAGE_DATA_FOR_DISTRICT",
  villages: [],
};

export const crops = [
  {
    id: "de8e724c-3ea7-4fd6-bca0-ebbc679c142d",
    code: "WHEAT",
    canonicalName: "Wheat",
    dataType: "OFFICIAL",
    season: { code: "RMS", name: "Rabi Marketing Season" },
    marketingYear: "2026-27",
    grades: [],
    eligibleCentreCount: 5,
  },
  {
    id: "aa1e724c-3ea7-4fd6-bca0-ebbc679c1111",
    code: "PADDY",
    canonicalName: "Paddy",
    dataType: "OFFICIAL",
    season: { code: "KMS", name: "Kharif Marketing Season" },
    marketingYear: "2026-27",
    grades: ["Common", "Grade A"],
    eligibleCentreCount: 2,
  },
];

export const centres = [
  {
    id: "55555555-0000-4000-a000-000000000002",
    code: "DEMO-UP-AGRA-01",
    name: "Agra Demonstration Procurement Centre",
    dataType: "CONFIGURED",
    district: { id: "44444444-0000-4000-a000-000000000012", name: "Agra" },
    timezone: "Asia/Kolkata",
    laneCount: 2,
    acceptedCrops: ["Wheat", "Paddy"],
    storage: {
      checkMode: "ADVISORY",
      status: "NOT_AVAILABLE",
      reasonCode: "NO_CAPACITY_DATA_FOR_CENTRE",
    },
  },
];

export const bookingConstraints = {
  quantity: {
    unit: "kg",
    minKg: 2500,
    maxKg: 5000,
    minQuintal: 25,
    maxQuintal: 50,
    kgPerQuintal: 100,
    integerOnly: true,
  },
};

export const availability = {
  centre: {
    code: "DEMO-UP-AGRA-01",
    name: "Agra Demonstration Procurement Centre",
    district: "Agra",
    timezone: "Asia/Kolkata",
    laneCount: 2,
    dataType: "CONFIGURED",
  },
  crop: { name: "Wheat", season: "RMS", marketingYear: "2026-27" },
  quantityKg: 3000,
  duration: { processingMinutes: 72, bufferMinutes: 15, occupancyMinutes: 87 },
  available: true,
  window: {
    serviceDate: "2026-09-07",
    laneNo: 1,
    scheduledStartAt: "2026-09-07T02:30:00.000Z",
    estimatedApproachAt: "2026-09-07T02:30:00.000Z",
    processingEndAt: "2026-09-07T03:42:00.000Z",
    windowEndAt: "2026-09-07T03:57:00.000Z",
    processingMinutes: 72,
    bufferMinutes: 15,
    occupancyMinutes: 87,
    centreTimezone: "Asia/Kolkata",
  },
  reasonCode: null,
  horizonDays: 7,
  storageCheck: {
    checkMode: "ADVISORY",
    status: "NOT_AVAILABLE",
    reasonCode: "NO_CAPACITY_DATA_FOR_CENTRE",
  },
};

export const noAvailability = {
  ...availability,
  available: false,
  window: null,
  reasonCode: "NO_AVAILABILITY",
};

export const booking = {
  bookingCode: "FQ-2026-2463892",
  tokenNumber: 1,
  status: "CONFIRMED",
  displayStatus: "BOOKED",
  centre: {
    code: "DEMO-UP-AGRA-01",
    name: "Agra Demonstration Procurement Centre",
    district: "Agra",
    timezone: "Asia/Kolkata",
    dataType: "CONFIGURED",
  },
  crop: { name: "Wheat", season: "RMS", marketingYear: "2026-27" },
  quantityKg: 3000,
  serviceDate: "2026-09-07",
  laneNo: 1,
  scheduledStartAt: "2026-09-07T02:30:00.000Z",
  estimatedApproachAt: "2026-09-07T02:30:00.000Z",
  processingEndAt: "2026-09-07T03:42:00.000Z",
  windowEndAt: "2026-09-07T03:57:00.000Z",
  processingMinutes: 72,
  bufferMinutes: 15,
  occupancyMinutes: 87,
  storageCheck: {
    checkMode: "ADVISORY",
    status: "NOT_AVAILABLE",
    reasonCode: "NO_CAPACITY_DATA_FOR_CENTRE",
  },
};

export const cancelledBooking = {
  ...booking,
  bookingCode: "FQ-2026-9755976",
  status: "CANCELLED",
  displayStatus: "CANCELLED",
};

export const queue = {
  bookingCode: "FQ-2026-2463892",
  tokenNumber: 1,
  status: "CONFIRMED",
  displayStatus: "BOOKED",
  queueState: "WAITING",
  inQueue: true,
  queuePosition: 1,
  aheadAtCentre: 0,
  aheadOnLane: 0,
  activeQueueSize: 1,
  laneNo: 1,
  laneCount: 2,
  currentlyServingToken: null,
  estimatedStartAt: "2026-09-07T02:30:00.000Z",
  estimatedEndAt: "2026-09-07T03:42:00.000Z",
  estimatedWaitMinutes: 9,
  etaConfidence: "PROJECTED",
  etaUnavailableReason: null,
  etaBasis: "Configured processing time for this booking's quantity.",
  scheduledStartAt: "2026-09-07T02:30:00.000Z",
  serviceDate: "2026-09-07",
  centreTimezone: "Asia/Kolkata",
  observedAt: "2026-09-07T02:21:00.000Z",
  serverTime: "2026-09-07T02:21:00.000Z",
  pollAfterSeconds: 5,
};

export const queueNoEta = {
  ...queue,
  inQueue: false,
  queueState: "NOT_IN_QUEUE",
  queuePosition: null,
  estimatedWaitMinutes: null,
  etaConfidence: "UNAVAILABLE",
  etaUnavailableReason: "SERVICE_COMPLETE",
};

export const procurement = {
  bookingCode: "FQ-2026-2463892",
  procurement: {
    status: "COMPLETED",
    qualityStatus: "ACCEPTED",
    arrivedAt: "2026-09-07T02:28:00.000Z",
    serviceStartedAt: "2026-09-07T02:31:00.000Z",
    serviceEndedAt: "2026-09-07T03:40:00.000Z",
    completedAt: "2026-09-07T03:41:00.000Z",
    grossQuantityKg: 3000,
    acceptedQuantityKg: 2480.5,
    rejectedQuantityKg: 519.5,
    grade: "FAQ",
    moisturePercent: 11.2,
    rejectionReason: null,
  },
  payment: {
    status: "PAID",
    blockedReason: null,
    currency: "INR",
    ratePerQuintalPaise: 258500,
    baseAmountPaise: 6412093,
    deductionsPaise: 0,
    deductionBreakdown: null,
    amountPaise: 6412093,
    amountRupees: "64120.93",
    paymentReference: "UTR-DEMO-0001",
    paidAt: "2026-09-07T05:00:00.000Z",
  },
};

export const payment = {
  bookingCode: "FQ-2026-2463892",
  payment: procurement.payment,
};

export const paymentBlocked = {
  bookingCode: "FQ-2026-2463892",
  payment: {
    ...procurement.payment,
    status: "BLOCKED",
    blockedReason: "MSP_AMBIGUOUS",
    amountPaise: null,
    amountRupees: null,
    paymentReference: null,
    paidAt: null,
  },
};

export const notifications = {
  count: 2,
  unreadCount: 1,
  notifications: [
    {
      id: "e0b1aaaa-1111-4000-a000-000000000001",
      type: "BOOKING_CONFIRMED",
      title: "Booking confirmed",
      message: "Your booking FQ-2026-2463892 at Agra is confirmed for 7 Sep 2026, token 1.",
      bookingCode: "FQ-2026-2463892",
      locale: "en",
      read: false,
      readAt: null,
      createdAt: "2026-09-03T05:12:44.001Z",
      delivery: {
        channel: "IN_APP",
        status: "SENT",
        sentAt: "2026-09-03T05:12:45.100Z",
        attempts: 1,
        demo: true,
        realSmsDelivered: false,
      },
    },
    {
      id: "e0b1aaaa-1111-4000-a000-000000000002",
      type: "PAYMENT_UPDATED",
      title: "Payment update",
      message: "Payment for booking FQ-2026-2463892 is now PAID.",
      bookingCode: "FQ-2026-2463892",
      locale: "en",
      read: true,
      readAt: "2026-09-03T06:00:00.000Z",
      createdAt: "2026-09-03T05:30:00.000Z",
      delivery: {
        channel: "IN_APP",
        status: "SENT",
        sentAt: "2026-09-03T05:30:01.000Z",
        attempts: 1,
        demo: true,
        realSmsDelivered: false,
      },
    },
  ],
};

export const preferences = {
  defaultWhenUnset: "ENABLED",
  note: "Every notification Mandi Sahayak sends is transactional and about your own booking, procurement or payment.",
  preferences: [
    { channel: "IN_APP", event: "ONE_DAY_REMINDER", scope: "EVENT", enabled: false },
  ],
};

export const otpChallenge = {
  challengeId: "bf85d4b7-6265-4904-ad7a-3adf984c7e0a",
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
  resendAvailableAt: new Date(Date.now() + 60_000).toISOString(),
  attemptsRemaining: 5,
  // Mirrors OTP_LENGTH in server/src/core/config.ts. The UI takes the box
  // count from this field, so it is the fixture that drives the assertion.
  otpLength: 4,
};

export const session = {
  userId: me.userId,
  roles: ["FARMER"],
  expiresAt: new Date(Date.now() + 43_200_000).toISOString(),
};
