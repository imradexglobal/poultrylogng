import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { db, nowISO, getActiveFarmId } from '@/db/database';
import { useLiveQuery } from 'dexie-react-hooks';
import { useToast } from '@/components/ToastProvider';
import { Tabs, EmptyState, Modal, ConfirmDialog, Badge } from '@/components/UI';
import { useFarm } from '@/contexts/FarmContext';
import { useAuth } from '@/contexts/AuthContext';
import { queueSync } from '@/db/sync';
import DailyReportShare from '@/components/DailyReportShare';
import {
  recordEggCollection,
  updateEggCollection,
  deleteEggCollection,
  recordFeedConsumption,
} from '@/db/stockService';
import type {
  DailyReport, EggCollection, MortalityRecord, FeedIntake,
  MedicationRecord, WeightRecord, EnvironmentRecord, Attachment, FeedInventoryItem
} from '@/db/types';
import {
  MORTALITY_REASONS, FEED_TYPES, FEED_SESSIONS, MEDICATION_CATEGORIES,
  ADMINISTRATION_METHODS, WEATHER_CONDITIONS, VENTILATION_STATUSES
} from '@/db/types';
import {
  DEFAULT_CRATE_CAPACITY,
  cratesAndPiecesToTotalEggs,
  totalEggsToCratesAndPieces,
  calculateGoodEggs,
  bagsToKg,
  kgToBags,
  kgToGrams,
  gramsToKg,
  gramsToDisplay,
  getLagosDate,
  getLagosTime,
} from '@/utils/conversions';

function emptyMortality(): MortalityRecord {
  return { numberDead: 0, reason: 'Unknown', notes: '', timePeriod: 'Morning' };
}

function emptyMedication(): MedicationRecord {
  return { medicationName: '', medicationCategory: 'Vaccine', quantityUsed: 0, unit: 'pieces', administrationMethod: 'Oral', supplier: '', notes: '', administeredBy: '', timeGiven: 'Morning' };
}
function emptyWeight(): WeightRecord {
  return { averageEggWeight: 0, averageBodyWeight: 0, eggWeightUnit: 'g', bodyWeightUnit: 'g' };
}

function emptyEnvironment(): EnvironmentRecord {
  return { temperature: 0, humidity: 0, weatherCondition: 'Sunny', ventilationStatus: 'Natural', lightHours: 0, waterConsumption: 0, waterUnit: 'L', notes: '' };
}

export default function DailyRecording() {
  const batches = useLiveQuery(() => db.batches.where('status').equals('active').toArray()) || [];
  const allReports = useLiveQuery(() => db.dailyReports.toArray()) || [];
  const { currentFarm } = useFarm();
  const { authUser } = useAuth();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [activeTab, setActiveTab] = useState('eggs');
  const [selectedDate, setSelectedDate] = useState(() => getLagosDate());
  const [selectedBatchId, setSelectedBatchId] = useState<number>(0);
  const [crateCapacity, setCrateCapacity] = useState(DEFAULT_CRATE_CAPACITY);

  // Initialize selected batch when batches load
  useEffect(() => {
    if (batches.length > 0 && !selectedBatchId) {
      setSelectedBatchId(batches[0].id!);
    }
  }, [batches, selectedBatchId]);

  // Load farm crate capacity setting
  useEffect(() => {
    async function loadCapacity() {
      const fid = currentFarm?.farmId || await getActiveFarmId();
      const setting = await db.settings.where({ farmId: fid, key: 'default_crate_capacity' }).first();
      if (setting && Number(setting.value) > 0) {
        setCrateCapacity(Number(setting.value));
      }
    }
    loadCapacity();
  }, [currentFarm]);

  const selectedBatch = useMemo(() => batches.find(b => b.id === selectedBatchId), [batches, selectedBatchId]);

  // Live queries for collections and feed inventory
  const dailyCollections = useLiveQuery(
    () => db.eggCollections.where('date').equals(selectedDate).toArray(),
    [selectedDate]
  ) || [];

  const batchCollections = useMemo(() => {
    if (!selectedBatchId) return dailyCollections;
    return dailyCollections.filter(c => c.batchId === selectedBatchId);
  }, [dailyCollections, selectedBatchId]);

  const feedInventories = useLiveQuery(
    () => db.feedInventory.toArray(),
    []
  ) || [];

  // ==================== EGG COLLECTION FORM STATE ====================
  const [collectionSession, setCollectionSession] = useState<'Morning' | 'Afternoon' | 'Evening' | 'Other'>('Morning');
  const [collectionTime, setCollectionTime] = useState(() => getLagosTime());
  const [inputCrates, setInputCrates] = useState<string>('');
  const [inputPieces, setInputPieces] = useState<string>('');
  const [inputCracked, setInputCracked] = useState<string>('');
  const [inputDamaged, setInputDamaged] = useState<string>('');
  const [inputNotes, setInputNotes] = useState<string>('');
  const [submittingEgg, setSubmittingEgg] = useState(false);

  // Edit egg collection modal state
  const [editingCollection, setEditingCollection] = useState<EggCollection | null>(null);
  const [editSession, setEditSession] = useState<'Morning' | 'Afternoon' | 'Evening' | 'Other'>('Morning');
  const [editTime, setEditTime] = useState('');
  const [editCrates, setEditCrates] = useState('');
  const [editPieces, setEditPieces] = useState('');
  const [editCracked, setEditCracked] = useState('');
  const [editDamaged, setEditDamaged] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  // Delete egg collection confirmation
  const [deletingCollection, setDeletingCollection] = useState<EggCollection | null>(null);

  // Live calculation for new collection input
  const liveTotalEggs = useMemo(() => {
    return cratesAndPiecesToTotalEggs(inputCrates, inputPieces, crateCapacity);
  }, [inputCrates, inputPieces, crateCapacity]);

  const liveGoodEggs = useMemo(() => {
    return calculateGoodEggs(liveTotalEggs, inputCracked, inputDamaged);
  }, [liveTotalEggs, inputCracked, inputDamaged]);

  // Daily summary calculations across all sessions today for selected batch (or farm)
  const dailySummary = useMemo(() => {
    const list = batchCollections;
    const crates = list.reduce((s, c) => s + c.crates, 0);
    const pieces = list.reduce((s, c) => s + c.pieces, 0);
    const totalEggs = list.reduce((s, c) => s + c.totalPieces, 0);
    const cracked = list.reduce((s, c) => s + c.cracked, 0);
    const damaged = list.reduce((s, c) => s + c.damaged, 0);
    const goodEggs = list.reduce((s, c) => s + c.goodEggs, 0);
    const normalized = totalEggsToCratesAndPieces(totalEggs, crateCapacity);

    return {
      totalCrates: crates,
      totalExtraPieces: pieces,
      totalEggs,
      cracked,
      damaged,
      goodEggs,
      normalizedCrates: normalized.crates,
      normalizedPieces: normalized.pieces,
      sessionsCount: list.length,
    };
  }, [batchCollections, crateCapacity]);

  // ==================== FEED CONSUMPTION FORM STATE ====================
  const [feedType, setFeedType] = useState('Layer Mash');
  const [feedSession, setFeedSession] = useState<'Morning' | 'Afternoon' | 'Evening' | 'Other'>('Morning');
  const [feedKgStr, setFeedKgStr] = useState<string>('');
  const [feedBagsStr, setFeedBagsStr] = useState<string>('');
  const [feedNotes, setFeedNotes] = useState('');
  const [submittingFeed, setSubmittingFeed] = useState(false);

  // Synchronized linked input handlers for Bags <-> Kg without infinite loops
  const handleFeedKgChange = (val: string) => {
    setFeedKgStr(val);
    const num = parseFloat(val);
    if (!isNaN(num) && num >= 0) {
      setFeedBagsStr(String(kgToBags(num)));
    } else {
      setFeedBagsStr('');
    }
  };

  const handleFeedBagsChange = (val: string) => {
    setFeedBagsStr(val);
    const num = parseFloat(val);
    if (!isNaN(num) && num >= 0) {
      setFeedKgStr(String(bagsToKg(num)));
    } else {
      setFeedKgStr('');
    }
  };

  const currentFeedStock = useMemo(() => {
    const found = feedInventories.find(f => f.feedType === feedType);
    return found ? found.balanceGrams : 0;
  }, [feedInventories, feedType]);

  // ==================== MORTALITY, MEDICATION, ETC. STATE ====================
  const [mortalityData, setMortalityData] = useState<MortalityRecord[]>([emptyMortality()]);
  const [medicationData, setMedicationData] = useState<MedicationRecord[]>([emptyMedication()]);
  const [weightData, setWeightData] = useState<WeightRecord>(emptyWeight());
  const [envData, setEnvData] = useState<EnvironmentRecord>(emptyEnvironment());
  const [generalNotes, setGeneralNotes] = useState('');
  const [showShareModal, setShowShareModal] = useState(false);

  // Attachments
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  // Load existing report for non-egg tabs
  const existingReport = useMemo(() => {
    if (!selectedBatchId) return null;
    return allReports.find(r => r.reportDate === selectedDate && r.batchId === selectedBatchId) || null;
  }, [allReports, selectedDate, selectedBatchId]);

  useEffect(() => {
    if (existingReport) {
      setMortalityData(existingReport.mortality.length > 0 ? existingReport.mortality : [emptyMortality()]);
      setMedicationData(existingReport.medication.length > 0 ? existingReport.medication : [emptyMedication()]);
      setWeightData(existingReport.weights.length > 0 ? existingReport.weights[0] : emptyWeight());
      setEnvData(existingReport.environment.length > 0 ? existingReport.environment[0] : emptyEnvironment());
      setGeneralNotes(existingReport.notes || '');
    } else {
      setMortalityData([emptyMortality()]);
      setMedicationData([emptyMedication()]);
      setWeightData(emptyWeight());
      setEnvData(emptyEnvironment());
      setGeneralNotes('');
    }
  }, [existingReport, selectedDate, selectedBatchId]);

  // ==================== HANDLERS: EGG COLLECTION ====================

  async function handleSaveEggCollection(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedBatchId || !selectedBatch) {
      toast('Please select a batch first', 'error');
      return;
    }

    const crates = Math.max(0, parseInt(inputCrates, 10) || 0);
    const pieces = Math.max(0, parseInt(inputPieces, 10) || 0);
    const cracked = Math.max(0, parseInt(inputCracked, 10) || 0);
    const damaged = Math.max(0, parseInt(inputDamaged, 10) || 0);
    const total = crates * crateCapacity + pieces;

    if (total <= 0 && cracked <= 0 && damaged <= 0) {
      toast('Please enter at least some collected, cracked, or damaged eggs', 'error');
      return;
    }

    setSubmittingEgg(true);
    try {
      const farmId = currentFarm?.farmId || await getActiveFarmId();
      await recordEggCollection({
        date: selectedDate,
        time: collectionTime || getLagosTime(),
        session: collectionSession,
        batchId: selectedBatchId,
        batchName: selectedBatch.batchName,
        crates,
        pieces,
        cracked,
        damaged,
        crateCapacity,
        notes: inputNotes,
        createdBy: authUser?.displayName || 'user',
        farmId,
      });

      toast(`Recorded ${collectionSession} collection: ${total.toLocaleString()} eggs!`, 'success');
      // Reset collection form inputs
      setInputCrates('');
      setInputPieces('');
      setInputCracked('');
      setInputDamaged('');
      setInputNotes('');
      setCollectionTime(getLagosTime());
      // Suggest next session
      if (collectionSession === 'Morning') setCollectionSession('Afternoon');
      else if (collectionSession === 'Afternoon') setCollectionSession('Evening');
      else setCollectionSession('Other');
    } catch (err) {
      toast(`Failed to record egg collection: ${(err as Error).message}`, 'error');
    } finally {
      setSubmittingEgg(false);
    }
  }

  function handleOpenEdit(coll: EggCollection) {
    setEditingCollection(coll);
    setEditSession(coll.session);
    setEditTime(coll.time);
    setEditCrates(String(coll.crates || 0));
    setEditPieces(String(coll.pieces || 0));
    setEditCracked(String(coll.cracked || 0));
    setEditDamaged(String(coll.damaged || 0));
    setEditNotes(coll.notes || '');
  }

  async function handleSaveEditedCollection() {
    if (!editingCollection?.id) return;
    setSavingEdit(true);
    try {
      await updateEggCollection(editingCollection.id, {
        date: editingCollection.date,
        time: editTime || editingCollection.time,
        session: editSession,
        crates: parseInt(editCrates, 10) || 0,
        pieces: parseInt(editPieces, 10) || 0,
        cracked: parseInt(editCracked, 10) || 0,
        damaged: parseInt(editDamaged, 10) || 0,
        notes: editNotes,
        modifiedBy: authUser?.displayName || 'user',
      });
      toast('Collection updated and daily totals recalculated!', 'success');
      setEditingCollection(null);
    } catch (err) {
      toast(`Update failed: ${(err as Error).message}`, 'error');
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleConfirmDelete() {
    if (!deletingCollection?.id) return;
    try {
      await deleteEggCollection(deletingCollection.id, authUser?.displayName || 'user');
      toast('Collection deleted and daily totals updated', 'info');
      setDeletingCollection(null);
    } catch (err) {
      toast(`Failed to delete: ${(err as Error).message}`, 'error');
    }
  }

  // ==================== HANDLERS: FEED CONSUMPTION ====================

  async function handleSaveFeedConsumption(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedBatchId || !selectedBatch) {
      toast('Please select a batch first', 'error');
      return;
    }
    const kg = parseFloat(feedKgStr) || 0;
    if (kg <= 0) {
      toast('Please enter a valid feed quantity (kg or bags)', 'error');
      return;
    }
    const grams = kgToGrams(kg);

    setSubmittingFeed(true);
    try {
      const farmId = currentFarm?.farmId || await getActiveFarmId();
      await recordFeedConsumption({
        consumptionDate: selectedDate,
        session: feedSession,
        feedType,
        quantityGrams: grams,
        kgInput: kg,
        bagsInput: parseFloat(feedBagsStr) || kgToBags(kg),
        batchId: selectedBatchId,
        batchName: selectedBatch.batchName,
        notes: feedNotes,
        createdBy: authUser?.displayName || 'user',
        farmId,
      });

      toast(`Recorded ${feedSession} feed: ${kg} kg (${(kg / 25).toFixed(2)} bags) of ${feedType}`, 'success');
      setFeedKgStr('');
      setFeedBagsStr('');
      setFeedNotes('');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setSubmittingFeed(false);
    }
  }

  // ==================== HANDLERS: MORTALITY & OTHER TABS ====================

  async function handleSaveOtherSections() {
  // Gather feed consumption records for this date & batch to embed in the daily report
  const feedRecords = await db.feedConsumptions
    .where('consumptionDate')
    .equals(selectedDate)
    .and(c => c.batchId === selectedBatchId)
    .toArray();
  const feedIntakeArray = feedRecords.map(fr => ({
    feedType: fr.feedType,
    feedBrand: '', // optional – can be extended later
    quantityGrams: fr.quantityGrams,
    feedingSession: fr.session,
    notes: fr.notes || '',
  }));

  if (!selectedBatchId || !selectedBatch) {
    toast('Please select a batch first', 'error');
    return;
  }

  const totalDead = mortalityData.reduce((s, m) => s + m.numberDead, 0);
  const oldDead = existingReport ? (existingReport.mortality || []).reduce((s, m) => s + m.numberDead, 0) : 0;
  const basePop = existingReport ? selectedBatch.currentPopulation + oldDead : selectedBatch.currentPopulation;
  const newPop = Math.max(0, basePop - totalDead);

  const now = nowISO();
  const farmId = currentFarm?.farmId || await getActiveFarmId();

  const reportData: Partial<DailyReport> = {
    farmId,
    reportDate: selectedDate,
    batchId: selectedBatchId,
    batchName: selectedBatch.batchName,
    mortality: mortalityData,
    medication: medicationData,
    feedIntake: feedIntakeArray,
    weights: [weightData],
    environment: [envData],
    notes: generalNotes,
    updatedAt: now,
    modifiedBy: authUser?.displayName || 'user',
  };



    // Update batch population
    await db.batches.update(selectedBatch.id!, {
      currentPopulation: newPop,
      updatedAt: now,
      syncStatus: 'pending',
    });

    toast('Daily report saved successfully!');
  }

  if (batches.length === 0) {
    return (
      <EmptyState
        icon="inventory_2"
        title="No Active Batches"
        description="Create at least one active batch before recording daily farm data"
        action={<a href="/poultry/batches" className="btn btn-primary">Go to Batch Management</a>}
      />
    );
  }

  const tabList = [
    { key: 'eggs', label: 'Egg Collection', icon: 'egg' },
    { key: 'feed', label: 'Feed Usage', icon: 'grass' },
    { key: 'mortality', label: 'Mortality', icon: 'dangerous' },
    { key: 'medication', label: 'Medication', icon: 'medication' },
    { key: 'weights', label: 'Weights & Env', icon: 'monitor_weight' },
    { key: 'notes', label: 'General Notes', icon: 'notes' },
  ];

  return (
    <div>
      {/* Top Header Card: Date, Batch, Share */}
      <div className="card mb-4" style={{ padding: 16 }}>
        <div className="form-row cols-3" style={{ alignItems: 'flex-end', margin: 0 }}>
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label" style={{ fontWeight: 600 }}>Collection Date</label>
            <input
              className="form-input"
              type="date"
              value={selectedDate}
              onChange={e => setSelectedDate(e.target.value)}
            />
          </div>

          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label" style={{ fontWeight: 600 }}>Flock / Batch <span className="required">*</span></label>
            <select
              className="form-select"
              value={selectedBatchId || ''}
              onChange={e => setSelectedBatchId(Number(e.target.value))}
            >
              {batches.map(b => (
                <option key={b.id} value={b.id}>
                  {b.batchName} ({b.house}) - {b.currentPopulation.toLocaleString()} birds
                </option>
              ))}
            </select>

          </div>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              className="btn"
              style={{ background: '#25D366', color: '#fff', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}
              onClick={() => setShowShareModal(true)}
              title="Share Today's Report on WhatsApp"
            >
              <span className="material-icons-outlined" style={{ fontSize: 18 }}>chat</span>
              WhatsApp Report
            </button>
            <a href="/poultry/daily/history" className="btn btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span className="material-icons-outlined" style={{ fontSize: 18 }}>history</span>
              History
            </a>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="card">
        <Tabs tabs={tabList} activeTab={activeTab} onTabChange={setActiveTab} />

        {/* ==================== TAB: EGG PRODUCTION ==================== */}
        {activeTab === 'eggs' && (
          <div className="tab-content">
            {/* Quick Collection Form */}
            <div className="card mb-4" style={{ background: '#F8FAF8', border: '1px solid #C8E6C9', borderRadius: 10, padding: 18 }}>
              <div className="flex justify-between items-center mb-3">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="material-icons-outlined" style={{ color: '#2E7D32', fontSize: 24 }}>add_circle</span>
                  <h3 style={{ fontSize: 16, margin: 0, fontWeight: 700, color: '#1B5E20' }}>
                    Record Egg Collection Session
                  </h3>
                </div>
                <Badge variant="neutral">Crate = {crateCapacity} Eggs</Badge>
              </div>

              <form onSubmit={handleSaveEggCollection}>
                <div className="form-row cols-4 mb-3">
                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label">Session <span className="required">*</span></label>
                    <select
                      className="form-select"
                      value={collectionSession}
                      onChange={e => setCollectionSession(e.target.value as any)}
                    >
                      <option value="Morning">Morning Collection</option>
                      <option value="Afternoon">Afternoon Collection</option>
                      <option value="Evening">Evening Collection</option>
                      <option value="Other">Other / Extra</option>
                    </select>

                  </div>

                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label">Time <span className="required">*</span></label>
                    <input
                      className="form-input"
                      type="time"
                      value={collectionTime}
                      onChange={e => setCollectionTime(e.target.value)}
                      required
                    />
                  </div>

                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label">Full Crates</label>
                    <input
                      className="form-input"
                      type="number"
                      min="0"
                      placeholder="0"
                      value={inputCrates}
                      onChange={e => setInputCrates(e.target.value)}
                    />
                    <span className="form-hint">{crateCapacity} eggs / crate</span>
                  </div>

                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label">Extra Pieces</label>
                    <input
                      className="form-input"
                      type="number"
                      min="0"
                      placeholder="0"
                      value={inputPieces}
                      onChange={e => setInputPieces(e.target.value)}
                    />
                    <span className="form-hint">Individual eggs</span>
                  </div>
                </div>

                <div className="form-row cols-3 mb-3">
                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label">⚠️ Cracked Eggs</label>
                    <input
                      className="form-input"
                      type="number"
                      min="0"
                      placeholder="0"
                      value={inputCracked}
                      onChange={e => setInputCracked(e.target.value)}
                    />
                    <span className="form-hint">Tracked separately</span>
                  </div>

                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label">❌ Damaged / Discarded</label>
                    <input
                      className="form-input"
                      type="number"
                      min="0"
                      placeholder="0"
                      value={inputDamaged}
                      onChange={e => setInputDamaged(e.target.value)}
                    />
                    <span className="form-hint">Production loss</span>
                  </div>

                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label">Notes (optional)</label>
                    <input
                      className="form-input"
                      placeholder="e.g. Broken during transit"
                      value={inputNotes}
                      onChange={e => setInputNotes(e.target.value)}
                    />
                  </div>
                </div>

                {/* Live Preview Card */}
                <div style={{
                  background: '#E8F5E9',
                  border: '1px solid #A5D6A7',
                  borderRadius: 8,
                  padding: '10px 16px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: 12,
                  marginBottom: 14
                }}>
                  <div style={{ fontSize: 14 }}>
                    <span>Total Collected: <strong>{liveTotalEggs.toLocaleString()} pieces</strong></span>
                    <span style={{ color: '#555', marginLeft: 8 }}>
                      ({Math.floor(liveTotalEggs / crateCapacity)} crates + {liveTotalEggs % crateCapacity} pieces)
                    </span>
                    &nbsp;|&nbsp;
                    <span style={{ color: '#2E7D32', fontWeight: 600 }}>Good/Sellable: {liveGoodEggs.toLocaleString()}</span>
                    &nbsp;|&nbsp;
                    <span style={{ color: '#E65100' }}>Cracked: {inputCracked || '0'}</span>
                    &nbsp;|&nbsp;
                    <span style={{ color: '#C62828' }}>Damaged: {inputDamaged || '0'}</span>
                  </div>

                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={submittingEgg || (liveTotalEggs <= 0 && Number(inputCracked) <= 0 && Number(inputDamaged) <= 0)}
                    style={{ minWidth: 160 }}
                  >
                    {submittingEgg ? 'Saving...' : `Save ${collectionSession} Entry`}
                  </button>
                </div>
              </form>
            </div>

            {/* Daily Collections Table for Selected Date */}
            <div className="mb-4">
              <div className="flex justify-between items-center mb-3">
                <h4 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>
                  Collections on {selectedDate} ({batchCollections.length} session{batchCollections.length !== 1 ? 's' : ''})
                </h4>
              </div>

              {batchCollections.length === 0 ? (
                <div className="empty-state" style={{ padding: 24, background: 'var(--md-surface-variant)', borderRadius: 8 }}>
                  <span className="material-icons-outlined" style={{ fontSize: 36, color: '#888' }}>egg</span>
                  <p style={{ margin: '8px 0 0', color: '#666' }}>No egg collections recorded yet for this date.</p>
                </div>
              ) : (
                <div className="table-container">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Session</th>
                        <th>Time</th>
                        <th>Full Crates</th>
                        <th>Extra Pieces</th>
                        <th>Total Collected</th>
                        <th>Good / Sellable</th>
                        <th>Cracked</th>
                        <th>Damaged</th>
                        <th>Notes</th>
                        <th style={{ textAlign: 'right' }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {batchCollections.map(coll => (
                        <tr key={coll.id}>
                          <td><strong>{coll.session}</strong></td>
                          <td>{coll.time}</td>
                          <td>{coll.crates} cr</td>
                          <td>{coll.pieces} pcs</td>
                          <td><strong style={{ color: '#1B5E20' }}>{coll.totalPieces.toLocaleString()}</strong></td>
                          <td><span style={{ color: '#2E7D32', fontWeight: 600 }}>{coll.goodEggs.toLocaleString()}</span></td>
                          <td>{coll.cracked > 0 ? <span style={{ color: '#E65100', fontWeight: 600 }}>{coll.cracked}</span> : '0'}</td>
                          <td>{coll.damaged > 0 ? <span style={{ color: '#C62828', fontWeight: 600 }}>{coll.damaged}</span> : '0'}</td>
                          <td style={{ color: '#666', fontSize: 13 }}>{coll.notes || '—'}</td>
                          <td style={{ textAlign: 'right' }}>
                            <div style={{ display: 'inline-flex', gap: 6 }}>
                              <button
                                className="btn btn-sm btn-outline"
                                onClick={() => handleOpenEdit(coll)}
                                title="Edit Collection"
                              >
                                <span className="material-icons-outlined" style={{ fontSize: 16 }}>edit</span>
                              </button>
                              <button
                                className="btn btn-sm btn-outline"
                                style={{ color: 'var(--md-error)' }}
                                onClick={() => setDeletingCollection(coll)}
                                title="Delete Collection"
                              >
                                <span className="material-icons-outlined" style={{ fontSize: 16 }}>delete</span>
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Cumulative Daily Summary Card */}
            <div className="card" style={{ background: '#E8F5E9', border: '1px solid #81C784', borderRadius: 10, padding: 20 }}>
              <h4 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 12px', color: '#1B5E20' }}>
                Daily Cumulative Summary ({selectedDate})
              </h4>
              <div className="grid grid-4" style={{ gap: 12 }}>
                <div className="stat-card" style={{ background: '#fff' }}>
                  <div className="stat-icon green"><span className="material-icons-outlined">inventory_2</span></div>
                  <div className="stat-info">
                    <h3>{dailySummary.totalCrates}</h3>
                    <p>Total Full Crates</p>
                  </div>
                </div>
                <div className="stat-card" style={{ background: '#fff' }}>
                  <div className="stat-icon green"><span className="material-icons-outlined">egg</span></div>
                  <div className="stat-info">
                    <h3>{dailySummary.totalExtraPieces}</h3>
                    <p>Total Extra Pieces</p>
                  </div>
                </div>
                <div className="stat-card" style={{ background: '#fff' }}>
                  <div className="stat-icon green"><span className="material-icons-outlined">equalizer</span></div>
                  <div className="stat-info">
                    <h3 style={{ color: '#1B5E20' }}>{dailySummary.totalEggs.toLocaleString()}</h3>
                    <p>Total Eggs Collected</p>
                  </div>
                </div>
                <div className="stat-card" style={{ background: '#fff' }}>
                  <div className="stat-icon teal"><span className="material-icons-outlined">check_circle</span></div>
                  <div className="stat-info">
                    <h3 style={{ color: '#2E7D32' }}>{dailySummary.goodEggs.toLocaleString()}</h3>
                    <p>Good / Sellable Eggs</p>
                  </div>
                </div>
              </div>

              <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                <div style={{ fontSize: 13, color: '#333' }}>
                  <span>⚠️ Cracked Eggs: <strong>{dailySummary.cracked}</strong></span>
                  <span style={{ margin: '0 10px' }}>|</span>
                  <span>❌ Damaged Eggs: <strong>{dailySummary.damaged}</strong></span>
                  <span style={{ margin: '0 10px' }}>|</span>
                  <span>Normalized: <strong>{dailySummary.normalizedCrates} crates + {dailySummary.normalizedPieces} pieces</strong></span>
                  <span style={{ margin: '0 10px' }}>|</span>
                  <span>Sessions: <strong>{dailySummary.sessionsCount}</strong></span>
                </div>

                <button
                  className="btn"
                  style={{ background: '#25D366', color: '#fff', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}
                  onClick={() => setShowShareModal(true)}
                  disabled={batchCollections.length === 0}
                >
                  <span className="material-icons-outlined" style={{ fontSize: 18 }}>chat</span>
                  Share Daily Report on WhatsApp
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ==================== TAB: FEED USAGE ==================== */}
        {activeTab === 'feed' && (
          <div className="tab-content">
            <div className="card mb-4" style={{ background: '#F8FAF8', border: '1px solid #C8E6C9', borderRadius: 10, padding: 18 }}>
              <div className="flex justify-between items-center mb-3">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="material-icons-outlined" style={{ color: '#2E7D32', fontSize: 24 }}>grass</span>
                  <h3 style={{ fontSize: 16, margin: 0, fontWeight: 700, color: '#1B5E20' }}>
                    Record Feed Consumption
                  </h3>
                </div>
                <div style={{ fontSize: 13, color: '#555' }}>
                  Available in store: <strong style={{ color: currentFeedStock <= 25000 ? '#C62828' : '#2E7D32' }}>{gramsToDisplay(currentFeedStock).display}</strong>
                </div>
              </div>

              <form onSubmit={handleSaveFeedConsumption}>
                <div className="form-row cols-3 mb-3">
                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label">Feed Type <span className="required">*</span></label>
                    <select
                      className="form-select"
                      value={feedType}
                      onChange={e => setFeedType(e.target.value)}
                    >
                      {FEED_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>

                  </div>

                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label">Feeding Session</label>
                    <select
                      className="form-select"
                      value={feedSession}
                      onChange={e => setFeedSession(e.target.value as any)}
                    >
                      {FEED_SESSIONS.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>

                  </div>

                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label">Notes (optional)</label>
                    <input
                      className="form-input"
                      placeholder="e.g. Mixed with vitamins"
                      value={feedNotes}
                      onChange={e => setFeedNotes(e.target.value)}
                    />
                  </div>
                </div>

                {/* Synchronized Linked Quantity Inputs: Bags <-> Kilograms */}
                <div style={{ background: '#E8F5E9', padding: 14, borderRadius: 8, marginBottom: 14 }}>
                  <div style={{ fontSize: 13, color: '#2E7D32', fontWeight: 600, marginBottom: 8 }}>
                    Quantity (Synchronized Linked Inputs — 1 Bag = 25 kg = 25,000 g):
                  </div>
                  <div className="form-row cols-2" style={{ margin: 0 }}>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label className="form-label">Quantity in Kilograms (kg)</label>
                      <input
                        className="form-input"
                        type="number"
                        step="0.1"
                        min="0"
                        placeholder="e.g. 50"
                        value={feedKgStr}
                        onChange={e => handleFeedKgChange(e.target.value)}
                      />
                    </div>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label className="form-label">Quantity in Bags (bags)</label>
                      <input
                        className="form-input"
                        type="number"
                        step="0.01"
                        min="0"
                        placeholder="e.g. 2"
                        value={feedBagsStr}
                        onChange={e => handleFeedBagsChange(e.target.value)}
                      />
                    </div>
                  </div>
                </div>

                <div className="flex justify-between items-center">
                  <span className="text-sm text-secondary">
                    {feedKgStr ? `${parseFloat(feedKgStr) || 0} kg (${((parseFloat(feedKgStr) || 0) / 25).toFixed(2)} bags) = ${(kgToGrams(parseFloat(feedKgStr) || 0)).toLocaleString()}g stored in database` : 'Enter kg or bags above'}
                  </span>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={submittingFeed || (parseFloat(feedKgStr) || 0) <= 0}
                  >
                    {submittingFeed ? 'Recording...' : `Record ${feedSession} Feed`}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* ==================== TAB: MORTALITY ==================== */}
        {activeTab === 'mortality' && (
          <div className="tab-content">
            <div className="flex justify-between items-center mb-4">
              <h3 style={{ fontSize: 15, margin: 0 }}>Mortality Records</h3>
              <button className="btn btn-text btn-sm" onClick={() => setMortalityData(d => [...d, emptyMortality()])}>
                <span className="material-icons-outlined" style={{ fontSize: 18 }}>add</span> Add Row
              </button>
            </div>
            {mortalityData.map((m, i) => (
              <div key={i} className="card mb-3" style={{ background: 'var(--md-surface-variant)' }}>
                <div className="flex justify-between items-center mb-3">
                  <span className="text-sm font-bold">Record #{i + 1}</span>
                  {mortalityData.length > 1 && (
                    <button className="btn btn-icon btn-text btn-sm" onClick={() => setMortalityData(d => d.filter((_, idx) => idx !== i))} style={{ color: 'var(--md-error)' }}>
                      <span className="material-icons-outlined" style={{ fontSize: 18 }}>close</span>
                    </button>
                  )}
                </div>
                <div className="form-row cols-2">
                  <div className="form-group">
                    <label className="form-label">Number Dead <span className="required">*</span></label>
                    <input className="form-input" type="number" min="0" value={m.numberDead || ''} onChange={e => setMortalityData(d => { const n = [...d]; n[i] = { ...n[i], numberDead: Number(e.target.value) }; return n; })} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Reason <span className="required">*</span></label>
                    <select className="form-select" value={m.reason} onChange={e => setMortalityData(d => { const n = [...d]; n[i] = { ...n[i], reason: e.target.value }; return n; })}>
                      {MORTALITY_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>

                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">Notes</label>
                  <input className="form-input" value={m.notes} onChange={e => setMortalityData(d => { const n = [...d]; n[i] = { ...n[i], notes: e.target.value }; return n; })} placeholder="Optional notes" />
                </div>
              </div>
            ))}
            <div className="card mb-4" style={{ background: '#FFEBEE', padding: 16 }}>
              <span className="font-bold">Total Mortality: {mortalityData.reduce((s, m) => s + m.numberDead, 0)} birds</span>
              {selectedBatch && (
                <span className="text-muted" style={{ marginLeft: 16 }}>
                  Flock Population after mortality: {Math.max(0, selectedBatch.currentPopulation - mortalityData.reduce((s, m) => s + m.numberDead, 0)).toLocaleString()} birds
                </span>
              )}
            </div>
            <button className="btn btn-primary" onClick={handleSaveOtherSections}>Save Mortality Records</button>
          </div>
        )}

        {/* ==================== TAB: MEDICATION ==================== */}
        {activeTab === 'medication' && (
          <div className="tab-content">
            <div className="flex justify-between items-center mb-4">
              <h3 style={{ fontSize: 15, margin: 0 }}>Medications & Vaccines</h3>
              <button className="btn btn-text btn-sm" onClick={() => setMedicationData(d => [...d, emptyMedication()])}>
                <span className="material-icons-outlined" style={{ fontSize: 18 }}>add</span> Add Medication
              </button>
            </div>
            {medicationData.map((m, i) => (
              <div key={i} className="card mb-3" style={{ background: 'var(--md-surface-variant)' }}>
                <div className="form-row cols-3 mb-2">
                  <div className="form-group">
                    <label className="form-label">Medication Name</label>
                    <input className="form-input" value={m.medicationName} onChange={e => setMedicationData(d => { const n = [...d]; n[i] = { ...n[i], medicationName: e.target.value }; return n; })} placeholder="e.g. Lasota" />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Category</label>
                    <select className="form-select" value={m.medicationCategory} onChange={e => setMedicationData(d => { const n = [...d]; n[i] = { ...n[i], medicationCategory: e.target.value }; return n; })}>
                      {MEDICATION_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>

                  </div>
                  <div className="form-group">
                    <label className="form-label">Method</label>
                    <select className="form-select" value={m.administrationMethod} onChange={e => setMedicationData(d => { const n = [...d]; n[i] = { ...n[i], administrationMethod: e.target.value }; return n; })}>
                      {ADMINISTRATION_METHODS.map(a => <option key={a} value={a}>{a}</option>)}
                    </select>

                  </div>
                </div>
              </div>
            ))}
            <button className="btn btn-primary" onClick={handleSaveOtherSections}>Save Medications</button>
          </div>
        )}

        {/* ==================== TAB: WEIGHTS & ENV ==================== */}
        {activeTab === 'weights' && (
          <div className="tab-content">
            <h3 style={{ fontSize: 15, marginBottom: 16 }}>Weights & Environmental Conditions</h3>
            <div className="form-row cols-2 mb-4">
              <div className="form-group">
                <label className="form-label">Average Egg Weight (g)</label>
                <input className="form-input" type="number" step="0.1" value={weightData.averageEggWeight || ''} onChange={e => setWeightData({ ...weightData, averageEggWeight: Number(e.target.value) })} />
              </div>
              <div className="form-group">
                <label className="form-label">Average Body Weight (g)</label>
                <input className="form-input" type="number" step="1" value={weightData.averageBodyWeight || ''} onChange={e => setWeightData({ ...weightData, averageBodyWeight: Number(e.target.value) })} />
              </div>
            </div>
            <div className="form-row cols-3 mb-4">
              <div className="form-group">
                <label className="form-label">Temperature (°C)</label>
                <input className="form-input" type="number" step="0.5" value={envData.temperature || ''} onChange={e => setEnvData({ ...envData, temperature: Number(e.target.value) })} />
              </div>
              <div className="form-group">
                <label className="form-label">Humidity (%)</label>
                <input className="form-input" type="number" value={envData.humidity || ''} onChange={e => setEnvData({ ...envData, humidity: Number(e.target.value) })} />
              </div>
              <div className="form-group">
                <label className="form-label">Weather</label>
                <select className="form-select" value={envData.weatherCondition} onChange={e => setEnvData({ ...envData, weatherCondition: e.target.value })}>
                  {WEATHER_CONDITIONS.map(w => <option key={w} value={w}>{w}</option>)}
                </select>

              </div>
            </div>
            <button className="btn btn-primary" onClick={handleSaveOtherSections}>Save Weights & Environment</button>
          </div>
        )}

        {/* ==================== TAB: GENERAL NOTES ==================== */}
        {activeTab === 'notes' && (
          <div className="tab-content">
            <h3 style={{ fontSize: 15, marginBottom: 16 }}>Daily Farm Notes</h3>
            <div className="form-group mb-4">
              <textarea
                className="form-input"
                rows={5}
                placeholder="Record general observations, visitor logs, pen cleanings, etc."
                value={generalNotes}
                onChange={e => setGeneralNotes(e.target.value)}
              />
            </div>
            <button className="btn btn-primary" onClick={handleSaveOtherSections}>Save Daily Notes</button>
          </div>
        )}
      </div>

      {/* Edit Egg Collection Modal */}
      <Modal
        open={!!editingCollection}
        title={`Edit Collection (#${editingCollection?.id || ''})`}
        onClose={() => setEditingCollection(null)}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setEditingCollection(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={handleSaveEditedCollection} disabled={savingEdit}>
              {savingEdit ? 'Saving...' : 'Update Collection'}
            </button>
          </>
        }
      >
        {editingCollection && (
          <div>
            <div className="form-row cols-2 mb-3">
              <div className="form-group">
                <label className="form-label">Session</label>
                <select className="form-select" value={editSession} onChange={e => setEditSession(e.target.value as any)}>
                  <option value="Morning">Morning</option>
                  <option value="Afternoon">Afternoon</option>
                  <option value="Evening">Evening</option>
                  <option value="Other">Other</option>
                </select>

              </div>
              <div className="form-group">
                <label className="form-label">Time</label>
                <input className="form-input" type="time" value={editTime} onChange={e => setEditTime(e.target.value)} />
              </div>
            </div>
            <div className="form-row cols-2 mb-3">
              <div className="form-group">
                <label className="form-label">Full Crates</label>
                <input className="form-input" type="number" min="0" value={editCrates} onChange={e => setEditCrates(e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">Extra Pieces</label>
                <input className="form-input" type="number" min="0" value={editPieces} onChange={e => setEditPieces(e.target.value)} />
              </div>
            </div>
            <div className="form-row cols-2 mb-3">
              <div className="form-group">
                <label className="form-label">Cracked Eggs</label>
                <input className="form-input" type="number" min="0" value={editCracked} onChange={e => setEditCracked(e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">Damaged Eggs</label>
                <input className="form-input" type="number" min="0" value={editDamaged} onChange={e => setEditDamaged(e.target.value)} />
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Notes</label>
              <input className="form-input" value={editNotes} onChange={e => setEditNotes(e.target.value)} />
            </div>
          </div>
        )}
      </Modal>

      {/* Delete Egg Collection Confirm Dialog */}
      <ConfirmDialog
        open={!!deletingCollection}
        title="Delete Egg Collection"
        message={`Are you sure you want to delete the ${deletingCollection?.session} collection (${deletingCollection?.totalPieces} eggs)? Daily totals will be automatically recalculated and inventory stock will be reversed.`}
        confirmLabel="Delete Collection"
        danger
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeletingCollection(null)}
      />

      {/* WhatsApp Daily Report Share Modal */}
      {showShareModal && (
        <DailyReportShare
          open={showShareModal}
          onClose={() => setShowShareModal(false)}
          report={existingReport || {
            farmId: currentFarm?.farmId || 'default-farm',
            reportDate: selectedDate,
            batchId: selectedBatchId,
            batchName: selectedBatch?.batchName || `Batch #${selectedBatchId}`,
            eggProduction: batchCollections.map(c => ({
              id: c.id,
              totalPieces: c.totalPieces,
              cracked: c.cracked,
              damaged: c.damaged,
              notes: c.notes,
              session: c.session,
              collectionTime: c.time,
            })),
            mortality: mortalityData,
            feedIntake: [],
            medication: medicationData,
            weights: [weightData],
            environment: [envData],
            notes: generalNotes,
            createdBy: authUser?.displayName || 'user',
            createdAt: nowISO(),
            modifiedBy: 'user',
            updatedAt: nowISO(),
            syncDate: '',
            syncStatus: 'pending',
          }}
          batch={selectedBatch || null}
          farmName={currentFarm?.farmName || 'PoultryLog Farm'}
          recordedBy={authUser?.displayName || 'Farm Manager'}
        />
      )}
    </div>
  );
}
