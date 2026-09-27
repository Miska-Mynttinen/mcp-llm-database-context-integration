import { type IndexSpec } from '@mcp-llm/database';

/** A sample table: portable DDL (SQLite, PostgreSQL, MySQL) and the rows it is seeded with. */
export interface SampleTable {
  readonly name: string;
  /** Column definitions and table constraints, in CREATE TABLE order. */
  readonly definition: readonly string[];
  readonly indexes: readonly Omit<IndexSpec, 'table'>[];
  readonly rows: readonly Readonly<Record<string, string | number | null>>[];
}

/** Something that can be shipped, and complained about. */
const product: SampleTable = {
  name: 'product',
  definition: [
    'id INTEGER PRIMARY KEY',
    'sku VARCHAR(32) NOT NULL UNIQUE',
    'name VARCHAR(255) NOT NULL',
    'category VARCHAR(64) NOT NULL',
    'unit_price DECIMAL(10,2) NOT NULL CHECK (unit_price >= 0)',
  ],
  indexes: [],
  rows: [
    { id: 1, sku: 'HW-100', name: 'Steel bracket', category: 'Hardware', unit_price: 4.5 },
    { id: 2, sku: 'HW-200', name: 'Hinge set', category: 'Hardware', unit_price: 12 },
    { id: 3, sku: 'EL-310', name: 'LED panel 60x60', category: 'Electrical', unit_price: 89.9 },
    { id: 4, sku: 'EL-320', name: 'Power supply 24V', category: 'Electrical', unit_price: 34.5 },
    { id: 5, sku: 'PK-010', name: 'Pallet wrap roll', category: 'Packaging', unit_price: 19.95 },
    { id: 6, sku: 'TL-450', name: 'Cordless drill', category: 'Tools', unit_price: 149 },
    { id: 7, sku: 'TL-460', name: 'Drill bit set', category: 'Tools', unit_price: 29.9 },
    { id: 8, sku: 'SF-700', name: 'Safety gloves (pair)', category: 'Safety', unit_price: 6.75 },
  ],
};

/** A delivery to one customer; it carries many units. Dates are unset until they happen. */
const shipment: SampleTable = {
  name: 'shipment',
  definition: [
    'id INTEGER PRIMARY KEY',
    'reference VARCHAR(32) NOT NULL UNIQUE',
    'customer_name VARCHAR(255) NOT NULL',
    'destination_city VARCHAR(128) NOT NULL',
    'destination_country CHAR(2) NOT NULL',
    'shipped_on DATE',
    'delivered_on DATE',
    "status VARCHAR(16) NOT NULL CHECK (status IN ('preparing', 'in_transit', 'delivered', 'returned'))",
  ],
  indexes: [],
  rows: [
    shipmentRow(1, 'Nordic Builders Oy', 'Helsinki', 'FI', '2026-01-08', '2026-01-12', 'delivered'),
    shipmentRow(2, 'Baltic Retail AS', 'Tallinn', 'EE', '2026-01-15', '2026-01-19', 'delivered'),
    shipmentRow(3, 'Kaupunki Electric', 'Tampere', 'FI', '2026-02-02', '2026-02-05', 'delivered'),
    shipmentRow(4, 'Svensson Bygg AB', 'Stockholm', 'SE', '2026-02-20', '2026-02-26', 'delivered'),
    shipmentRow(5, 'Nordic Builders Oy', 'Espoo', 'FI', '2026-03-10', '2026-03-13', 'returned'),
    shipmentRow(6, 'Oslo Verktoy AS', 'Oslo', 'NO', '2026-04-03', '2026-04-09', 'delivered'),
    shipmentRow(7, 'Baltic Retail AS', 'Riga', 'LV', '2026-05-18', '2026-05-23', 'delivered'),
    shipmentRow(8, 'Kaupunki Electric', 'Turku', 'FI', '2026-08-28', '2026-09-01', 'delivered'),
    shipmentRow(9, 'Svensson Bygg AB', 'Gothenburg', 'SE', '2026-09-22', null, 'in_transit'),
    shipmentRow(10, 'Oslo Verktoy AS', 'Bergen', 'NO', null, null, 'preparing'),
  ],
};

/**
 * An amount of one product in one shipment. (id, shipment_id) is unique so that a complaint can
 * reference a unit together with its shipment.
 */
const unit: SampleTable = {
  name: 'unit',
  definition: [
    'id INTEGER PRIMARY KEY',
    'shipment_id INTEGER NOT NULL REFERENCES shipment (id)',
    'product_id INTEGER NOT NULL REFERENCES product (id)',
    'quantity INTEGER NOT NULL CHECK (quantity > 0)',
    'batch_code VARCHAR(32) NOT NULL',
    'UNIQUE (id, shipment_id)',
  ],
  indexes: [
    { name: 'idx_unit_shipment', columns: ['shipment_id'] },
    { name: 'idx_unit_product', columns: ['product_id'] },
  ],
  rows: [
    unitRow(1, 1, 1, 500, 'B-2601-A'),
    unitRow(2, 1, 2, 120, 'B-2601-B'),
    unitRow(3, 1, 8, 200, 'B-2512-S'),
    unitRow(4, 2, 5, 80, 'B-2601-P'),
    unitRow(5, 2, 7, 60, 'B-2512-T'),
    unitRow(6, 3, 3, 40, 'B-2601-E'),
    unitRow(7, 3, 4, 40, 'B-2601-F'),
    unitRow(8, 4, 1, 1000, 'B-2602-A'),
    unitRow(9, 4, 6, 25, 'B-2601-T'),
    unitRow(10, 4, 7, 25, 'B-2601-U'),
    unitRow(11, 5, 3, 60, 'B-2602-E'),
    unitRow(12, 5, 4, 30, 'B-2602-F'),
    unitRow(13, 6, 6, 50, 'B-2603-T'),
    unitRow(14, 6, 8, 300, 'B-2603-S'),
    unitRow(15, 7, 5, 150, 'B-2604-P'),
    unitRow(16, 7, 2, 90, 'B-2604-B'),
    unitRow(17, 8, 3, 24, 'B-2607-E'),
    unitRow(18, 8, 4, 48, 'B-2607-F'),
    unitRow(19, 8, 1, 400, 'B-2608-A'),
    unitRow(20, 9, 6, 40, 'B-2608-T'),
    unitRow(21, 9, 7, 40, 'B-2608-U'),
    unitRow(22, 10, 2, 200, 'B-2609-B'),
    unitRow(23, 10, 8, 500, 'B-2609-S'),
  ],
};

/** A complaint about one unit of a shipment; the composite key keeps the unit in that shipment. */
const complaints: SampleTable = {
  name: 'complaints',
  definition: [
    'id INTEGER PRIMARY KEY',
    'shipment_id INTEGER NOT NULL REFERENCES shipment (id)',
    'unit_id INTEGER NOT NULL',
    'reported_on DATE NOT NULL',
    "category VARCHAR(16) NOT NULL CHECK (category IN ('damaged', 'missing', 'wrong_item', 'defective'))",
    'description VARCHAR(500) NOT NULL',
    'quantity_affected INTEGER NOT NULL CHECK (quantity_affected > 0)',
    "status VARCHAR(16) NOT NULL CHECK (status IN ('open', 'investigating', 'resolved', 'rejected'))",
    'resolved_on DATE',
    'FOREIGN KEY (unit_id, shipment_id) REFERENCES unit (id, shipment_id)',
  ],
  indexes: [
    { name: 'idx_complaints_shipment', columns: ['shipment_id'] },
    { name: 'idx_complaints_unit', columns: ['unit_id', 'shipment_id'] },
  ],
  rows: [
    complaintRow(1, 1, 2, '2026-01-14', 'damaged', 'Hinge sets arrived with bent mounting plates', 15, 'resolved', '2026-01-22'),
    complaintRow(2, 3, 6, '2026-02-09', 'defective', 'LED panels flicker after ten minutes of use', 6, 'resolved', '2026-02-27'),
    complaintRow(3, 3, 7, '2026-02-09', 'defective', 'Power supplies fail under full load', 4, 'resolved', '2026-02-27'),
    complaintRow(4, 4, 8, '2026-02-27', 'missing', '940 brackets delivered, 1000 invoiced', 60, 'resolved', '2026-03-06'),
    complaintRow(5, 5, 11, '2026-03-15', 'defective', 'LED panels dead on arrival; the whole shipment was returned', 60, 'resolved', '2026-03-30'),
    complaintRow(6, 5, 12, '2026-03-15', 'wrong_item', '12V power supplies delivered instead of 24V', 30, 'resolved', '2026-03-30'),
    complaintRow(7, 6, 13, '2026-04-12', 'damaged', 'Two drills with cracked housings; the carrier reports the cases intact', 2, 'rejected', '2026-04-20'),
    complaintRow(8, 7, 15, '2026-05-26', 'missing', 'Twelve rolls of pallet wrap short', 12, 'resolved', '2026-06-02'),
    complaintRow(9, 8, 17, '2026-09-03', 'defective', 'LED panels flicker, same symptom as SHP-2026-003', 5, 'investigating', null),
    complaintRow(10, 8, 19, '2026-09-04', 'damaged', 'Brackets rusted; the packaging was wet', 40, 'open', null),
  ],
};

/** In creation order: each table only references tables before it. */
export const SAMPLE_TABLES: readonly SampleTable[] = [product, shipment, unit, complaints];

function shipmentRow(
  id: number,
  customerName: string,
  destinationCity: string,
  destinationCountry: string,
  shippedOn: string | null,
  deliveredOn: string | null,
  status: string,
): SampleTable['rows'][number] {
  return {
    id,
    reference: `SHP-2026-${String(id).padStart(3, '0')}`,
    customer_name: customerName,
    destination_city: destinationCity,
    destination_country: destinationCountry,
    shipped_on: shippedOn,
    delivered_on: deliveredOn,
    status,
  };
}

function unitRow(id: number, shipmentId: number, productId: number, quantity: number, batchCode: string): SampleTable['rows'][number] {
  return { id, shipment_id: shipmentId, product_id: productId, quantity, batch_code: batchCode };
}

function complaintRow(
  id: number,
  shipmentId: number,
  unitId: number,
  reportedOn: string,
  category: string,
  description: string,
  quantityAffected: number,
  status: string,
  resolvedOn: string | null,
): SampleTable['rows'][number] {
  return {
    id,
    shipment_id: shipmentId,
    unit_id: unitId,
    reported_on: reportedOn,
    category,
    description,
    quantity_affected: quantityAffected,
    status,
    resolved_on: resolvedOn,
  };
}
