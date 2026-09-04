import { useEffect, useMemo, useRef, useState } from "react";

const getDateValue = (date = new Date()) =>
  new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);

const getEarliestActiveDate = () => getDateValue();

const createQueueForDate = () => [];

const defaultMspRates = {
  Wheat: 2275,
  Rice: 2225,
  Mustard: 5650,
  Gram: 5230,
};

const createMorningSetup = () => ({
  weighbridgeWorking: true,
  storageRemaining: 16400,
  slotsOpen: 6,
  shiftStart: "08:00",
  shiftEnd: "18:00",
  acceptedCrops: ["Wheat", "Rice", "Mustard"],
  farmersPerSlot: 10,
  mspRates: { ...defaultMspRates },
});

const createSampleQueueForDate = (date) => [
  {
    id: "sample-1",
    name: "Rajesh Kumar",
    phone: "9876543210",
    slot: "08:00",
    crop: "Wheat",
    quantity: 210,
    landArea: "1.2 ha",
    token: "FQ-1001",
    status: "Queued",
    grossWeight: "",
    tareWeight: "",
    bagWeight: "",
    slipNumber: "",
    actualWeight: "",
    paidAmount: "",
    lateMinutes: "",
    paymentStatus: "Pending",
    reportSaved: false,
    rejectionReason: "",
    quality: {
      moisture: "",
      foreignMatter: "",
      brokenGrain: "",
    },
    date,
  },
  {
    id: "sample-2",
    name: "Suresh Yadav",
    phone: "9812345678",
    slot: "09:00",
    crop: "Rice",
    quantity: 180,
    landArea: "1.5 ha",
    token: "FQ-1002",
    status: "Queued",
    grossWeight: "",
    tareWeight: "",
    bagWeight: "",
    slipNumber: "",
    actualWeight: "",
    paidAmount: "",
    lateMinutes: "",
    paymentStatus: "Pending",
    reportSaved: false,
    rejectionReason: "",
    quality: {
      moisture: "",
      foreignMatter: "",
      brokenGrain: "",
    },
    date,
  },
  {
    id: "sample-3",
    name: "Pawan Verma",
    phone: "9023456781",
    slot: "10:00",
    crop: "Mustard",
    quantity: 95,
    landArea: "0.8 ha",
    token: "FQ-1003",
    status: "Queued",
    grossWeight: "",
    tareWeight: "",
    bagWeight: "",
    slipNumber: "",
    actualWeight: "",
    paidAmount: "",
    lateMinutes: "",
    paymentStatus: "Pending",
    reportSaved: false,
    rejectionReason: "",
    quality: {
      moisture: "",
      foreignMatter: "",
      brokenGrain: "",
    },
    date,
  },
];

const initialStorage = [
  { crop: "Wheat", stock: 1040, capacity: 1500, remaining: 460 },
  { crop: "Rice", stock: 820, capacity: 1200, remaining: 380 },
  { crop: "Mustard", stock: 640, capacity: 900, remaining: 260 },
];

const STORAGE_KEY = "faramqueue.daily.state.v2";

const normalizeFarmerBooking = (booking, fallbackDate) => {
  const normalized = booking && typeof booking === "object" ? booking : {};
  const dateValue = normalized.date ?? fallbackDate ?? getDateValue();
  const generatedId =
    normalized.id ??
    `farmer-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  return {
    ...normalized,
    id: String(generatedId),
    name: normalized.name ?? "Farmer",
    phone: normalized.phone ?? normalized.mobile ?? "",
    slot: normalized.slot ?? "08:00",
    crop: normalized.crop ?? "Wheat",
    quantity: Number(normalized.quantity ?? 0),
    landArea: normalized.landArea ?? "1.0 ha",
    token: normalized.token ?? `FQ-${Date.now().toString().slice(-6)}`,
    status: normalized.status ?? "Queued",
    grossWeight: normalized.grossWeight ?? "",
    tareWeight: normalized.tareWeight ?? "",
    bagWeight: normalized.bagWeight ?? "",
    slipNumber: normalized.slipNumber ?? "",
    actualWeight: normalized.actualWeight ?? "",
    paidAmount: normalized.paidAmount ?? "",
    lateMinutes: normalized.lateMinutes ?? "",
    paymentStatus: normalized.paymentStatus ?? "Pending",
    reportSaved: Boolean(normalized.reportSaved),
    rejectionReason: normalized.rejectionReason ?? "",
    quality: {
      moisture: normalized.quality?.moisture ?? "",
      foreignMatter: normalized.quality?.foreignMatter ?? "",
      brokenGrain: normalized.quality?.brokenGrain ?? "",
    },
    date: dateValue,
  };
};

const getGeneratedSlots = (setup) => {
  const slotCount = Number(setup.slotsOpen || 1);
  const startHour = 8;

  return Array.from({ length: slotCount }, (_, index) => {
    const hour = startHour + index;
    const time = `${String(hour).padStart(2, "0")}:00`;
    return time;
  });
};

const loadState = () => {
  const today = getDateValue();

  try {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Ignore storage access issues and fall back to the default demo state.
  }

  return {
    selectedDate: today,
    dailyQueueByDate: { [today]: createSampleQueueForDate(today) },
    storage: initialStorage,
    dateRecords: { [today]: [] },
    morningSetup: createMorningSetup(),
  };
};

export const useFaramqueueState = () => {
  const persistedState = loadState();
  const alertTimerRef = useRef(null);

  const [selectedDate, setSelectedDate] = useState(persistedState.selectedDate);
  const [dailyQueueByDate, setDailyQueueByDate] = useState(
    persistedState.dailyQueueByDate,
  );
  const [storage, setStorage] = useState(persistedState.storage);
  const [selectedReportFarmerId, setSelectedReportFarmerId] = useState(null);
  const [savedReportFarmerId, setSavedReportFarmerId] = useState(null);
  const [dateRecords, setDateRecords] = useState(persistedState.dateRecords);
  const [paymentAlert, setPaymentAlert] = useState(null);
  const [morningSetup, setMorningSetup] = useState(persistedState.morningSetup);

  useEffect(() => {
    try {
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // Storage is intentionally disabled so the app always starts from the default demo data.
    }
  }, [selectedDate, dailyQueueByDate, storage, dateRecords, morningSetup]);

  const farmers = dailyQueueByDate[selectedDate] ?? [];

  const selectedDateEntries = useMemo(() => {
    const queueEntries = farmers
      .filter(
        (farmer) =>
          farmer.status === "Cleared" ||
          farmer.paymentStatus === "Cleared" ||
          farmer.reportSaved,
      )
      .map((farmer) => ({ ...farmer, date: farmer.date ?? selectedDate }));

    const historicalEntries = (dateRecords[selectedDate] ?? []).map(
      (entry) => ({
        ...entry,
        date: entry.date ?? selectedDate,
      }),
    );

    const mergedEntries = [...historicalEntries, ...queueEntries];
    const byId = {};

    mergedEntries.forEach((entry) => {
      byId[String(entry.id)] = entry;
    });

    return Object.values(byId).sort((a, b) => Number(b.id) - Number(a.id));
  }, [dateRecords, farmers, selectedDate]);

  const queueStats = useMemo(() => {
    const active = farmers.filter(
      (farmer) => farmer.status !== "Cleared",
    ).length;
    const processed = farmers.filter(
      (farmer) => farmer.status === "Cleared",
    ).length;
    const arrived = farmers.filter(
      (farmer) => farmer.status === "Arrived",
    ).length;

    return [
      {
        label: "Total today",
        value: String(farmers.length),
        tone: "bg-green-100",
      },
      { label: "Active", value: String(active), tone: "bg-emerald-100" },
      { label: "Arrived", value: String(arrived), tone: "bg-lime-100" },
      { label: "Cleared", value: String(processed), tone: "bg-emerald-200" },
    ];
  }, [farmers]);

  const showPaymentAlert = (message, tone = "warning") => {
    setPaymentAlert({ message, tone });

    if (alertTimerRef.current) {
      clearTimeout(alertTimerRef.current);
    }

    alertTimerRef.current = setTimeout(() => {
      setPaymentAlert(null);
    }, 3200);
  };

  const updateFarmer = (id, field, value) => {
    const patch = { [field]: value };

    setDailyQueueByDate((prev) => ({
      ...prev,
      [selectedDate]: (prev[selectedDate] ?? []).map((farmer) =>
        farmer.id === id ? { ...farmer, ...patch } : farmer,
      ),
    }));

    setDateRecords((prev) => ({
      ...prev,
      [selectedDate]: (prev[selectedDate] ?? []).map((entry) =>
        entry.id === id ? { ...entry, ...patch } : entry,
      ),
    }));
  };

  const addFarmer = (booking) => {
    const normalizedFarmer = normalizeFarmerBooking(booking, selectedDate);
    const nextList = [
      ...(dailyQueueByDate[selectedDate] ?? []),
      normalizedFarmer,
    ];

    setDailyQueueByDate((prev) => ({
      ...prev,
      [selectedDate]: nextList,
    }));

    return normalizedFarmer;
  };

  const handleDateChange = (nextDate) => {
    const today = getEarliestActiveDate();
    if (!nextDate || nextDate < today || nextDate === selectedDate) return;

    setSelectedDate(nextDate);
    setSelectedReportFarmerId(null);
    setSavedReportFarmerId(null);

    setDailyQueueByDate((prev) => ({
      ...prev,
      [nextDate]: prev[nextDate] ?? createQueueForDate(nextDate),
    }));
  };

  const handlePaymentStatusChange = (id, nextStatus) => {
    const liveFarmer = farmers.find((entry) => entry.id === id);
    const historicalFarmer = (dateRecords[selectedDate] ?? []).find(
      (entry) => entry.id === id,
    );
    const farmer = liveFarmer ?? historicalFarmer;

    if (!farmer) return;

    if (farmer.paymentStatus === "Cleared" && nextStatus !== "Cleared") {
      showPaymentAlert(
        "This payment was already cleared and cannot be changed back.",
        "danger",
      );
      return;
    }

    updateFarmer(id, "paymentStatus", nextStatus);

    if (nextStatus === "Cleared") {
      updateFarmer(id, "status", "Cleared");
      updateFarmer(id, "reportSaved", true);
      setSelectedReportFarmerId(id);
      setSavedReportFarmerId(id);

      const amount = Number(farmer.paidAmount || 0);
      showPaymentAlert(
        `Rs. ${amount.toLocaleString("en-IN")} transferred to farmer account.`,
        "success",
      );
    }
  };

  const acknowledgeSavedReport = () => setSavedReportFarmerId(null);

  const verifyFarmer = (id) => {
    updateFarmer(id, "status", "Verified");
    showPaymentAlert("Farmer verified for gate entry.", "success");
  };

  const markFarmerArrived = (id) => {
    const farmer = (dailyQueueByDate[selectedDate] ?? []).find(
      (entry) => entry.id === id,
    );
    if (!farmer) return null;

    updateFarmer(id, "status", "Arrived");
    showPaymentAlert(
      `SMS sent to ${farmer.name} for gate confirmation.`,
      "success",
    );
    return farmer;
  };

  const clearFarmer = (id) => {
    const farmer = (dailyQueueByDate[selectedDate] ?? []).find(
      (entry) => entry.id === id,
    );
    if (!farmer) return null;

    updateFarmer(id, "status", "Cleared");
    updateFarmer(id, "reportSaved", true);
    setSelectedReportFarmerId(id);

    return farmer;
  };

  const saveFarmerReport = (id, reportPatch) => {
    const farmer = (dailyQueueByDate[selectedDate] ?? []).find(
      (entry) => entry.id === id,
    );
    if (!farmer) return;

    const cropRate = morningSetup.mspRates?.[farmer.crop] ?? 0;
    const actualWeight = Number(
      reportPatch.actualWeight ?? farmer.actualWeight ?? 0,
    );
    const paymentAmount = actualWeight * cropRate;

    updateFarmer(
      id,
      "actualWeight",
      String(actualWeight || farmer.actualWeight || ""),
    );
    updateFarmer(id, "paidAmount", String(paymentAmount || ""));
    updateFarmer(
      id,
      "lateMinutes",
      String(reportPatch.lateMinutes ?? farmer.lateMinutes ?? ""),
    );
    updateFarmer(id, "status", "Payment");
    updateFarmer(
      id,
      "paymentStatus",
      reportPatch.paymentStatus ?? farmer.paymentStatus ?? "Pending",
    );
    updateFarmer(id, "reportSaved", true);
    updateFarmer(
      id,
      "rejectionReason",
      reportPatch.rejectionReason ?? farmer.rejectionReason ?? "",
    );

    if (reportPatch.quality) {
      updateFarmer(id, "quality", reportPatch.quality);
    }

    showPaymentAlert(
      `Report saved for ${farmer.name}. Payment due: ₹${paymentAmount.toLocaleString("en-IN")}`,
      "success",
    );
  };

  const slotOptions = getGeneratedSlots(morningSetup);

  return {
    farmers,
    selectedDateEntries,
    storage,
    queueStats,
    paymentAlert,
    selectedDate,
    selectedReportFarmerId,
    savedReportFarmerId,
    acknowledgeSavedReport,
    morningSetup,
    setMorningSetup,
    slotOptions,
    addFarmer,
    clearFarmer,
    saveFarmerReport,
    handleDateChange,
    handlePaymentStatusChange,
    updateFarmer,
    verifyFarmer,
    markFarmerArrived,
    updateCropStorage: (cropName, patch = {}) => {
      setStorage((prev) =>
        prev.map((entry) => {
          if (entry.crop !== cropName) return entry;

          const nextCapacity = Number(patch.capacity ?? entry.capacity ?? 0);
          const safeCapacity = Number.isFinite(nextCapacity) ? nextCapacity : 0;
          const currentRemaining = Number(
            patch.remaining ??
              entry.remaining ??
              Math.max(safeCapacity - (entry.stock ?? 0), 0),
          );
          const clampedRemaining = Math.min(
            Math.max(
              Number.isFinite(currentRemaining) ? currentRemaining : 0,
              0,
            ),
            safeCapacity,
          );
          const nextStock = Math.max(safeCapacity - clampedRemaining, 0);

          return {
            ...entry,
            capacity: safeCapacity,
            remaining: clampedRemaining,
            stock: nextStock,
          };
        }),
      );
    },
  };
};
