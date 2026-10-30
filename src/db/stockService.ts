import { db, nowISO, getActiveFarmId } from './database';
import type {
  EggCollection, EggInventory, EggStockMovement,
  FeedInventoryItem, FeedStockMovement, FeedPurchaseRecord, FeedConsumptionRecord,
  DailyReport, EggProduction, FeedIntake
} from './types';
import {
  DEFAULT_CRATE_CAPACITY,
  cratesAndPiecesToTotalEggs,
  totalEggsToCratesAndPieces,
  calculateGoodEggs,
} from '@/utils/conversions';
import { queueSync } from './sync';

// ==================== EGG INVENTORY OPERATIONS ====================

/**
 * Gets or initializes egg inventory for the given or active farm.
 */
export async function getEggInventory(farmId?: string): Promise<EggInventory> {
  const fid = farmId || await getActiveFarmId();
  let inv = await db.eggInventory.where('farmId').equals(fid).first();
  if (!inv) {
    const id = await db.eggInventory.add({
      farmId: fid,
      goodEggsPieces: 0,
      crackedEggsPieces: 0,
      damagedEggsPieces: 0,
      crateCapacity: DEFAULT_CRATE_CAPACITY,
      lastUpdated: nowISO(),
      syncStatus: 'synced',
    });
    inv = await db.eggInventory.get(id as number);
  }
  return inv!;
}

/**
 * Records an egg collection session (Morning, Afternoon, Evening, etc.)
 * Saves independently, updates egg inventory, creates audit movement, and updates daily report aggregates.
 */
export async function recordEggCollection(data: {
  date: string;
  time: string;
  session: 'Morning' | 'Afternoon' | 'Evening' | 'Other';
  batchId: number;
  batchName: string;
  crates: number;
  pieces: number;
  cracked: number;
  damaged: number;
  crateCapacity?: number;
  notes?: string;
  createdBy?: string;
  farmId?: string;
}): Promise<number> {
  const fid = data.farmId || await getActiveFarmId();
  const cap = data.crateCapacity || DEFAULT_CRATE_CAPACITY;
  const crates = Math.max(0, Math.floor(data.crates || 0));
  const pieces = Math.max(0, Math.floor(data.pieces || 0));
  const cracked = Math.max(0, Math.floor(data.cracked || 0));
  const damaged = Math.max(0, Math.floor(data.damaged || 0));
  const totalPieces = cratesAndPiecesToTotalEggs(crates, pieces, cap);
  const goodEggs = calculateGoodEggs(totalPieces, cracked, damaged);
  const now = nowISO();
  const user = data.createdBy || 'user';

  return await db.transaction('rw', [db.eggCollections, db.eggInventory, db.eggStockMovements, db.dailyReports], async () => {
    // 1. Add collection record
    const collectionData: Omit<EggCollection, 'id'> = {
      farmId: fid,
      date: data.date,
      time: data.time,
      session: data.session,
      batchId: data.batchId,
      batchName: data.batchName,
      crates,
      pieces,
      totalPieces,
      cracked,
      damaged,
      goodEggs,
      crateCapacity: cap,
      notes: data.notes || '',
      createdBy: user,
      createdAt: now,
      updatedAt: now,
      syncStatus: 'pending',
    };
    const collectionId = await db.eggCollections.add(collectionData as EggCollection);

    // 2. Update egg inventory
    let inv = await db.eggInventory.where('farmId').equals(fid).first();
    if (!inv) {
      const invId = await db.eggInventory.add({
        farmId: fid,
        goodEggsPieces: goodEggs,
        crackedEggsPieces: cracked,
        damagedEggsPieces: damaged,
        crateCapacity: cap,
        lastUpdated: now,
        syncStatus: 'pending',
      });
      inv = await db.eggInventory.get(invId as number);
    } else {
      const newGood = inv.goodEggsPieces + goodEggs;
      const newCracked = inv.crackedEggsPieces + cracked;
      const newDamaged = inv.damagedEggsPieces + damaged;
      await db.eggInventory.update(inv.id!, {
        goodEggsPieces: newGood,
        crackedEggsPieces: newCracked,
        damagedEggsPieces: newDamaged,
        lastUpdated: now,
        syncStatus: 'pending',
      });
      inv.goodEggsPieces = newGood;
      inv.crackedEggsPieces = newCracked;
      inv.damagedEggsPieces = newDamaged;
    }

    // 3. Record stock movement audit
    const movement: Omit<EggStockMovement, 'id'> = {
      farmId: fid,
      date: data.date,
      time: data.time,
      type: 'production',
      goodEggsChange: goodEggs,
      crackedEggsChange: cracked,
      damagedEggsChange: damaged,
      goodEggsBalance: inv!.goodEggsPieces,
      crackedEggsBalance: inv!.crackedEggsPieces,
      referenceType: 'collection',
      referenceId: collectionId as number,
      reason: `${data.session} collection (${crates} cr + ${pieces} pcs)`,
      createdBy: user,
      createdAt: now,
      syncStatus: 'pending',
    };
    const movId = await db.eggStockMovements.add(movement as EggStockMovement);

    // 4. Update DailyReport cumulative aggregation
    await syncDailyReportAggregates(fid, data.date, data.batchId, data.batchName, user);

    return { collectionId: collectionId as number, movId: movId as number, collectionData, movement };
  }).then(async ({ collectionId, movId, collectionData, movement }) => {
    // Queue sync outside transaction to avoid syncQueue object store conflict
    await queueSync('eggCollections', collectionId, 'create', { ...collectionData, id: collectionId });
    await queueSync('eggStockMovements', movId, 'create', { ...movement, id: movId });
    return collectionId;
  });
}

/**
 * Updates an existing egg collection and recalculates inventory and daily reports.
 */
export async function updateEggCollection(id: number, data: {
  date: string;
  time: string;
  session: 'Morning' | 'Afternoon' | 'Evening' | 'Other';
  crates: number;
  pieces: number;
  cracked: number;
  damaged: number;
  notes?: string;
  modifiedBy?: string;
}): Promise<void> {
  const existing = await db.eggCollections.get(id);
  if (!existing) throw new Error('Collection record not found');

  const fid = existing.farmId;
  const cap = existing.crateCapacity || DEFAULT_CRATE_CAPACITY;
  const crates = Math.max(0, Math.floor(data.crates || 0));
  const pieces = Math.max(0, Math.floor(data.pieces || 0));
  const cracked = Math.max(0, Math.floor(data.cracked || 0));
  const damaged = Math.max(0, Math.floor(data.damaged || 0));
  const newTotalPieces = cratesAndPiecesToTotalEggs(crates, pieces, cap);
  const newGoodEggs = calculateGoodEggs(newTotalPieces, cracked, damaged);
  const now = nowISO();
  const user = data.modifiedBy || 'user';

  // Differences
  const diffGood = newGoodEggs - existing.goodEggs;
  const diffCracked = cracked - existing.cracked;
  const diffDamaged = damaged - existing.damaged;

  await db.transaction('rw', [db.eggCollections, db.eggInventory, db.eggStockMovements, db.dailyReports], async () => {
    // 1. Update collection record
    await db.eggCollections.update(id, {
      date: data.date,
      time: data.time,
      session: data.session,
      crates,
      pieces,
      totalPieces: newTotalPieces,
      cracked,
      damaged,
      goodEggs: newGoodEggs,
      notes: data.notes ?? existing.notes,
      updatedAt: now,
      syncStatus: 'pending',
    });

    // 2. Adjust egg inventory by difference
    const inv = await getEggInventory(fid);
    const newGood = Math.max(0, inv.goodEggsPieces + diffGood);
    const newCracked = Math.max(0, inv.crackedEggsPieces + diffCracked);
    const newDamaged = Math.max(0, inv.damagedEggsPieces + diffDamaged);
    await db.eggInventory.update(inv.id!, {
      goodEggsPieces: newGood,
      crackedEggsPieces: newCracked,
      damagedEggsPieces: newDamaged,
      lastUpdated: now,
      syncStatus: 'pending',
    });

    // 3. Add adjustment movement
    const movement: Omit<EggStockMovement, 'id'> = {
      farmId: fid,
      date: data.date,
      time: data.time,
      type: 'adjustment',
      goodEggsChange: diffGood,
      crackedEggsChange: diffCracked,
      damagedEggsChange: diffDamaged,
      goodEggsBalance: newGood,
      crackedEggsBalance: newCracked,
      referenceType: 'collection',
      referenceId: id,
      reason: `Edit collection #${id} (${existing.session} -> ${data.session})`,
      createdBy: user,
      createdAt: now,
      syncStatus: 'pending',
    };
    const movId = await db.eggStockMovements.add(movement as EggStockMovement);

    // 4. Update DailyReport cumulative aggregation
    await syncDailyReportAggregates(fid, data.date, existing.batchId, existing.batchName, user);
    if (data.date !== existing.date) {
      await syncDailyReportAggregates(fid, existing.date, existing.batchId, existing.batchName, user);
    }

    return { movId: movId as number, movement };
  }).then(async ({ movId, movement }) => {
    // Queue sync outside transaction
    await queueSync('eggCollections', id, 'update', { ...existing, ...data, id });
    await queueSync('eggStockMovements', movId, 'create', { ...movement, id: movId });
  });
}

/**
 * Deletes an egg collection, reverses its inventory impact, and updates daily reports.
 */
export async function deleteEggCollection(id: number, deletedBy = 'user'): Promise<void> {
  const existing = await db.eggCollections.get(id);
  if (!existing) return;

  const fid = existing.farmId;
  const now = nowISO();

  await db.transaction('rw', [db.eggCollections, db.eggInventory, db.eggStockMovements, db.dailyReports], async () => {
    // 1. Delete collection
    await db.eggCollections.delete(id);

    // 2. Reversal from egg inventory
    const inv = await getEggInventory(fid);
    const newGood = Math.max(0, inv.goodEggsPieces - existing.goodEggs);
    const newCracked = Math.max(0, inv.crackedEggsPieces - existing.cracked);
    const newDamaged = Math.max(0, inv.damagedEggsPieces - existing.damaged);
    await db.eggInventory.update(inv.id!, {
      goodEggsPieces: newGood,
      crackedEggsPieces: newCracked,
      damagedEggsPieces: newDamaged,
      lastUpdated: now,
      syncStatus: 'pending',
    });

    // 3. Audit movement
    const movement: Omit<EggStockMovement, 'id'> = {
      farmId: fid,
      date: existing.date,
      time: existing.time,
      type: 'reversal',
      goodEggsChange: -existing.goodEggs,
      crackedEggsChange: -existing.cracked,
      damagedEggsChange: -existing.damaged,
      goodEggsBalance: newGood,
      crackedEggsBalance: newCracked,
      referenceType: 'collection',
      referenceId: id,
      reason: `Deleted collection #${id} (${existing.session})`,
      createdBy: deletedBy,
      createdAt: now,
      syncStatus: 'pending',
    };
    const movId = await db.eggStockMovements.add(movement as EggStockMovement);

    // 4. Update daily report
    await syncDailyReportAggregates(fid, existing.date, existing.batchId, existing.batchName, deletedBy);

    return { movId: movId as number, movement };
  }).then(async ({ movId, movement }) => {
    // Queue sync outside transaction
    await queueSync('eggCollections', id, 'delete', null);
    await queueSync('eggStockMovements', movId, 'create', { ...movement, id: movId });
  });
}

/**
 * Manual egg stock adjustment / reconciliation with audit trail.
 */
export async function adjustEggStock(params: {
  goodEggsAdjustmentPieces: number;
  crackedEggsAdjustmentPieces: number;
  reason: string;
  user: string;
  farmId?: string;
}): Promise<void> {
  const fid = params.farmId || await getActiveFarmId();
  const now = nowISO();
  const inv = await getEggInventory(fid);

  const prevGood = inv.goodEggsPieces;
  const prevCracked = inv.crackedEggsPieces;
  const newGood = Math.max(0, prevGood + params.goodEggsAdjustmentPieces);
  const newCracked = Math.max(0, prevCracked + params.crackedEggsAdjustmentPieces);

  await db.transaction('rw', [db.eggInventory, db.eggStockMovements], async () => {
    await db.eggInventory.update(inv.id!, {
      goodEggsPieces: newGood,
      crackedEggsPieces: newCracked,
      lastUpdated: now,
      syncStatus: 'pending',
    });

    const mov: Omit<EggStockMovement, 'id'> = {
      farmId: fid,
      date: now.split('T')[0],
      time: now.split('T')[1].substring(0, 5),
      type: 'adjustment',
      goodEggsChange: params.goodEggsAdjustmentPieces,
      crackedEggsChange: params.crackedEggsAdjustmentPieces,
      damagedEggsChange: 0,
      goodEggsBalance: newGood,
      crackedEggsBalance: newCracked,
      referenceType: 'manual_adjustment',
      referenceId: `ADJ-${Date.now()}`,
      reason: params.reason || 'Manual stock reconciliation',
      createdBy: params.user,
      createdAt: now,
      syncStatus: 'pending',
    };
    const movId = await db.eggStockMovements.add(mov as EggStockMovement);
    return { movId: movId as number, mov };
  }).then(async ({ movId, mov }) => {
    await queueSync('eggStockMovements', movId, 'create', { ...mov, id: movId });
  });
}

/**
 * Deducts eggs sold from inventory.
 * Validates available stock first to prevent negative stock!
 */
export async function deductEggSale(params: {
  invoiceNumber: string;
  items: Array<{
    productName: string;
    isCracked?: boolean;
    quantity: number; // crates or pieces depending on unit
    unit: string;
  }>;
  user?: string;
  farmId?: string;
}): Promise<void> {
  const fid = params.farmId || await getActiveFarmId();
  const inv = await getEggInventory(fid);
  const cap = inv.crateCapacity || DEFAULT_CRATE_CAPACITY;

  let goodPiecesToDeduct = 0;
  let crackedPiecesToDeduct = 0;

  for (const item of params.items) {
    const isCracked = item.isCracked || item.productName.toLowerCase().includes('cracked');
    const unitLower = (item.unit || '').toLowerCase();
    const isCrate = unitLower.includes('crate') || unitLower === 'cr';

    const pieces = isCrate ? item.quantity * cap : item.quantity;

    if (isCracked) {
      crackedPiecesToDeduct += pieces;
    } else {
      goodPiecesToDeduct += pieces;
    }
  }

  if (goodPiecesToDeduct === 0 && crackedPiecesToDeduct === 0) return;

  if (inv.goodEggsPieces < goodPiecesToDeduct) {
    const avail = totalEggsToCratesAndPieces(inv.goodEggsPieces, cap);
    const req = totalEggsToCratesAndPieces(goodPiecesToDeduct, cap);
    throw new Error(`Insufficient good eggs in stock. Required: ${req.display}, Available: ${avail.display}`);
  }

  if (inv.crackedEggsPieces < crackedPiecesToDeduct) {
    throw new Error(`Insufficient cracked eggs in stock. Required: ${crackedPiecesToDeduct} pieces, Available: ${inv.crackedEggsPieces} pieces`);
  }

  const now = nowISO();
  const newGood = inv.goodEggsPieces - goodPiecesToDeduct;
  const newCracked = inv.crackedEggsPieces - crackedPiecesToDeduct;

  await db.transaction('rw', [db.eggInventory, db.eggStockMovements], async () => {
    await db.eggInventory.update(inv.id!, {
      goodEggsPieces: newGood,
      crackedEggsPieces: newCracked,
      lastUpdated: now,
      syncStatus: 'pending',
    });

    const mov: Omit<EggStockMovement, 'id'> = {
      farmId: fid,
      date: now.split('T')[0],
      time: now.split('T')[1].substring(0, 5),
      type: 'sale',
      goodEggsChange: -goodPiecesToDeduct,
      crackedEggsChange: -crackedPiecesToDeduct,
      damagedEggsChange: 0,
      goodEggsBalance: newGood,
      crackedEggsBalance: newCracked,
      referenceType: 'sale_invoice',
      referenceId: params.invoiceNumber,
      reason: `Invoice ${params.invoiceNumber}`,
      createdBy: params.user || 'user',
      createdAt: now,
      syncStatus: 'pending',
    };
    const movId = await db.eggStockMovements.add(mov as EggStockMovement);
    return { movId: movId as number, mov };
  }).then(async ({ movId, mov }) => {
    await queueSync('eggStockMovements', movId, 'create', { ...mov, id: movId });
  });
}

/**
 * Restores egg inventory if an invoice is cancelled or voided.
 */
export async function restoreEggSale(invoiceNumber: string, farmId?: string): Promise<void> {
  const fid = farmId || await getActiveFarmId();
  const salesMovements = await db.eggStockMovements
    .where('farmId')
    .equals(fid)
    .filter(m => m.referenceType === 'sale_invoice' && String(m.referenceId) === invoiceNumber && m.type === 'sale')
    .toArray();

  if (salesMovements.length === 0) return;

  const goodToRestore = salesMovements.reduce((s, m) => s + Math.abs(m.goodEggsChange), 0);
  const crackedToRestore = salesMovements.reduce((s, m) => s + Math.abs(m.crackedEggsChange), 0);
  const now = nowISO();
  const inv = await getEggInventory(fid);

  const newGood = inv.goodEggsPieces + goodToRestore;
  const newCracked = inv.crackedEggsPieces + crackedToRestore;

  await db.transaction('rw', [db.eggInventory, db.eggStockMovements], async () => {
    await db.eggInventory.update(inv.id!, {
      goodEggsPieces: newGood,
      crackedEggsPieces: newCracked,
      lastUpdated: now,
      syncStatus: 'pending',
    });

    const mov: Omit<EggStockMovement, 'id'> = {
      farmId: fid,
      date: now.split('T')[0],
      time: now.split('T')[1].substring(0, 5),
      type: 'reversal',
      goodEggsChange: goodToRestore,
      crackedEggsChange: crackedToRestore,
      damagedEggsChange: 0,
      goodEggsBalance: newGood,
      crackedEggsBalance: newCracked,
      referenceType: 'sale_invoice',
      referenceId: invoiceNumber,
      reason: `Reversal of cancelled/voided invoice ${invoiceNumber}`,
      createdBy: 'system',
      createdAt: now,
      syncStatus: 'pending',
    };
    const movId = await db.eggStockMovements.add(mov as EggStockMovement);
    return { movId: movId as number, mov };
  }).then(async ({ movId, mov }) => {
    await queueSync('eggStockMovements', movId, 'create', { ...mov, id: movId });
  });
}

// ==================== FEED INVENTORY OPERATIONS ====================

/**
 * Gets feed inventory balance for a feed type, or creates one if not present.
 */
export async function getFeedBalance(feedType: string, farmId?: string): Promise<FeedInventoryItem> {
  const fid = farmId || await getActiveFarmId();
  let item = await db.feedInventory.where({ farmId: fid, feedType }).first();
  if (!item) {
    const id = await db.feedInventory.add({
      farmId: fid,
      feedType,
      balanceGrams: 0,
      minStockGrams: 50000,
      lastUpdated: nowISO(),
      syncStatus: 'synced',
    });
    item = await db.feedInventory.get(id as number);
  }
  return item!;
}

/**
 * Records a feed purchase (stock in).
 * Quantity is authoritative in integer grams.
 */
export async function recordFeedPurchase(params: {
  purchaseDate: string;
  feedType: string;
  feedBrand?: string;
  quantityGrams: number;
  bagsInput?: number;
  kgInput?: number;
  unitPrice?: number;
  totalCost?: number;
  supplierName?: string;
  invoiceNumber?: string;
  notes?: string;
  createdBy?: string;
  farmId?: string;
}): Promise<number> {
  const fid = params.farmId || await getActiveFarmId();
  const now = nowISO();
  const user = params.createdBy || 'user';
  const qty = Math.max(0, Math.round(params.quantityGrams));

  if (qty <= 0) throw new Error('Purchase quantity must be greater than zero');

  return await db.transaction('rw', [db.feedPurchases, db.feedInventory, db.feedStockMovements], async () => {
    // 1. Add purchase record
    const record: Omit<FeedPurchaseRecord, 'id'> = {
      farmId: fid,
      purchaseDate: params.purchaseDate,
      feedType: params.feedType,
      feedBrand: params.feedBrand || '',
      quantityGrams: qty,
      bagsInput: params.bagsInput,
      kgInput: params.kgInput,
      unitPrice: params.unitPrice,
      totalCost: params.totalCost,
      supplierName: params.supplierName || '',
      invoiceNumber: params.invoiceNumber || '',
      notes: params.notes || '',
      createdBy: user,
      createdAt: now,
      updatedAt: now,
      syncStatus: 'pending',
    };
    const purchaseId = await db.feedPurchases.add(record as FeedPurchaseRecord);

    // 2. Update feed inventory
    const item = await getFeedBalance(params.feedType, fid);
    const newBalance = item.balanceGrams + qty;
    await db.feedInventory.update(item.id!, {
      balanceGrams: newBalance,
      lastUpdated: now,
      syncStatus: 'pending',
    });

    // 3. Audit movement
    const mov: Omit<FeedStockMovement, 'id'> = {
      farmId: fid,
      date: params.purchaseDate,
      feedType: params.feedType,
      type: 'purchase',
      quantityGrams: qty,
      changeGrams: qty,
      balanceGrams: newBalance,
      referenceType: 'purchase',
      referenceId: purchaseId as number,
      reason: `Purchased ${(qty / 1000).toFixed(1)} kg (${(qty / 25000).toFixed(1)} bags)${params.supplierName ? ` from ${params.supplierName}` : ''}`,
      createdBy: user,
      createdAt: now,
      syncStatus: 'pending',
    };
    const movId = await db.feedStockMovements.add(mov as FeedStockMovement);

    return { purchaseId: purchaseId as number, movId: movId as number, record, mov };
  }).then(async ({ purchaseId, movId, record, mov }) => {
    await queueSync('feedPurchases', purchaseId, 'create', { ...record, id: purchaseId });
    await queueSync('feedStockMovements', movId, 'create', { ...mov, id: movId });
    return purchaseId;
  });
}

/**
 * Records feed consumption (stock out).
 * Checks available stock. Prevents consumption exceeding available stock unless explicitly authorized.
 */
export async function recordFeedConsumption(params: {
  consumptionDate: string;
  session: 'Morning' | 'Afternoon' | 'Evening' | 'Other';
  feedType: string;
  quantityGrams: number;
  bagsInput?: number;
  kgInput?: number;
  batchId?: number;
  batchName?: string;
  notes?: string;
  allowNegativeStock?: boolean;
  createdBy?: string;
  farmId?: string;
}): Promise<number> {
  const fid = params.farmId || await getActiveFarmId();
  const now = nowISO();
  const user = params.createdBy || 'user';
  const qty = Math.max(0, Math.round(params.quantityGrams));

  if (qty <= 0) throw new Error('Feed consumption quantity must be greater than zero');

  const item = await getFeedBalance(params.feedType, fid);

  if (item.balanceGrams < qty && !params.allowNegativeStock) {
    const availKg = (item.balanceGrams / 1000).toFixed(1);
    const reqKg = (qty / 1000).toFixed(1);
    throw new Error(`Insufficient stock for ${params.feedType}. Required: ${reqKg} kg, Available: ${availKg} kg`);
  }

  return await db.transaction('rw', [db.feedConsumptions, db.feedInventory, db.feedStockMovements, db.dailyReports], async () => {
    // 1. Add consumption record
    const record: Omit<FeedConsumptionRecord, 'id'> = {
      farmId: fid,
      consumptionDate: params.consumptionDate,
      session: params.session,
      feedType: params.feedType,
      quantityGrams: qty,
      bagsInput: params.bagsInput,
      kgInput: params.kgInput,
      batchId: params.batchId,
      batchName: params.batchName || '',
      notes: params.notes || '',
      createdBy: user,
      createdAt: now,
      updatedAt: now,
      syncStatus: 'pending',
    };
    const consumptionId = await db.feedConsumptions.add(record as FeedConsumptionRecord);

    // 2. Decrement feed inventory
    const newBalance = Math.max(0, item.balanceGrams - qty);
    await db.feedInventory.update(item.id!, {
      balanceGrams: newBalance,
      lastUpdated: now,
      syncStatus: 'pending',
    });

    // 3. Stock movement
    const mov: Omit<FeedStockMovement, 'id'> = {
      farmId: fid,
      date: params.consumptionDate,
      feedType: params.feedType,
      type: 'consumption',
      quantityGrams: qty,
      changeGrams: -qty,
      balanceGrams: newBalance,
      referenceType: 'consumption',
      referenceId: consumptionId as number,
      reason: `${params.session} feeding (${(qty / 1000).toFixed(1)} kg)${params.batchName ? ` for ${params.batchName}` : ''}`,
      createdBy: user,
      createdAt: now,
      syncStatus: 'pending',
    };
    const movId = await db.feedStockMovements.add(mov as FeedStockMovement);

    return { consumptionId: consumptionId as number, movId: movId as number, record, mov };
  }).then(async ({ consumptionId, movId, record, mov }) => {
    // Queue sync outside transaction
    await queueSync('feedConsumptions', consumptionId, 'create', { ...record, id: consumptionId });
    await queueSync('feedStockMovements', movId, 'create', { ...mov, id: movId });
    return consumptionId;
  });
}

/**
 * Manual feed stock adjustment.
 */
export async function adjustFeedStock(params: {
  feedType: string;
  changeGrams: number;
  reason: string;
  user: string;
  farmId?: string;
}): Promise<void> {
  const fid = params.farmId || await getActiveFarmId();
  const now = nowISO();
  const item = await getFeedBalance(params.feedType, fid);
  const change = Math.round(params.changeGrams);
  const newBalance = Math.max(0, item.balanceGrams + change);

  await db.transaction('rw', [db.feedInventory, db.feedStockMovements], async () => {
    await db.feedInventory.update(item.id!, {
      balanceGrams: newBalance,
      lastUpdated: now,
      syncStatus: 'pending',
    });

    const mov: Omit<FeedStockMovement, 'id'> = {
      farmId: fid,
      date: now.split('T')[0],
      feedType: params.feedType,
      type: change >= 0 ? 'adjustment_in' : 'adjustment_out',
      quantityGrams: Math.abs(change),
      changeGrams: change,
      balanceGrams: newBalance,
      referenceType: 'manual_adjustment',
      referenceId: `FADJ-${Date.now()}`,
      reason: params.reason || 'Manual feed stock adjustment',
      createdBy: params.user,
      createdAt: now,
      syncStatus: 'pending',
    };
    const movId = await db.feedStockMovements.add(mov as FeedStockMovement);
    return { movId: movId as number, mov };
  }).then(async ({ movId, mov }) => {
    await queueSync('feedStockMovements', movId, 'create', { ...mov, id: movId });
  });
}

// ==================== CUMULATIVE DAILY AGGREGATION ====================

/**
 * Automatically synchronizes cumulative daily egg and feed records into DailyReport
 * whenever egg collections or feed entries change.
 */
export async function syncDailyReportAggregates(
  farmId: string,
  date: string,
  batchId: number,
  batchName?: string,
  user = 'user'
): Promise<void> {
  const collections = await db.eggCollections
    .where({ farmId, date, batchId })
    .toArray();

  const eggRows: EggProduction[] = collections.map(c => ({
    id: c.id,
    collectionId: c.id,
    collectionTime: c.time,
    session: c.session,
    crates: c.crates,
    pieces: c.pieces,
    totalPieces: c.totalPieces,
    cracked: c.cracked,
    damaged: c.damaged,
    goodEggs: c.goodEggs,
    notes: c.notes,
  }));

  const consumptions = await db.feedConsumptions
    .where({ farmId, consumptionDate: date, batchId })
    .toArray();

  const feedRows: FeedIntake[] = consumptions.map(f => ({
    id: f.id,
    feedType: f.feedType,
    feedBrand: '',
    quantityGrams: f.quantityGrams,
    feedingSession: f.session,
    notes: f.notes || '',
  }));

  const existingReport = await db.dailyReports
    .where({ farmId, reportDate: date, batchId })
    .first();

  const now = nowISO();

  if (existingReport?.id) {
    await db.dailyReports.update(existingReport.id, {
      eggProduction: eggRows,
      feedIntake: feedRows.length > 0 ? feedRows : existingReport.feedIntake,
      updatedAt: now,
      modifiedBy: user,
      syncStatus: 'pending',
    });
  } else if (eggRows.length > 0 || feedRows.length > 0) {
    const reportData: Omit<DailyReport, 'id'> = {
      farmId,
      reportDate: date,
      batchId,
      batchName: batchName || `Batch #${batchId}`,
      eggProduction: eggRows,
      mortality: [],
      feedIntake: feedRows,
      medication: [],
      weights: [],
      environment: [],
      notes: '',
      createdBy: user,
      createdAt: now,
      modifiedBy: user,
      updatedAt: now,
      syncDate: '',
      syncStatus: 'pending',
    };
    await db.dailyReports.add(reportData as DailyReport);
  }
}
