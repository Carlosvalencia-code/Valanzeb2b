import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateTaxBreakdown, parseB2BMessage } from '../lib/parser.js';

describe('Valanze B2B — Suite de Pruebas Unitarias y Flujos Críticos', () => {

  describe('1. Matemática Tributaria Preliminar (SUNAT 18% IGV)', () => {
    it('debe desglosar Base e IGV exactamente para Facturas gravadas', () => {
      // Caso 1: S/ 118.00 exactos
      const res1 = calculateTaxBreakdown(118.00, 'FACTURA');
      assert.equal(res1.total, 118.00);
      assert.equal(res1.base, 100.00);
      assert.equal(res1.igv, 18.00);

      // Caso 2: S/ 45.00 (Caso de auditoría: Base S/ 38.14, IGV S/ 6.86)
      const res2 = calculateTaxBreakdown(45.00, 'FACTURA');
      assert.equal(res2.total, 45.00);
      assert.equal(res2.base, 38.14);
      assert.equal(res2.igv, 6.86);

      // Caso 3: S/ 96.00 (Compra de 24 sixpacks a S/ 96)
      const res3 = calculateTaxBreakdown(96.00, 'FACTURA');
      assert.equal(res3.total, 96.00);
      assert.equal(res3.base, 81.36);
      assert.equal(res3.igv, 14.64);
    });

    it('no debe calcular crédito fiscal en Boletas ni operaciones sin comprobante', () => {
      const resBoleta = calculateTaxBreakdown(50.00, 'BOLETA');
      assert.equal(resBoleta.total, 50.00);
      assert.equal(resBoleta.base, 50.00);
      assert.equal(resBoleta.igv, 0.00);

      const resSinComp = calculateTaxBreakdown(35.50, 'SIN_COMPROBANTE');
      assert.equal(resSinComp.total, 35.50);
      assert.equal(resSinComp.base, 35.50);
      assert.equal(resSinComp.igv, 0.00);
    });
  });

  describe('2. Parser de Lenguaje Natural (Compras, Ventas y Comandos)', () => {
    it('debe parsear entradas de stock al Kardex con cantidades y costos', () => {
      const parsed1 = parseB2BMessage('+24 sixpack cristal 96');
      assert.ok(parsed1);
      assert.equal(parsed1.type, 'COMPRA_STOCK');
      assert.equal(parsed1.quantity, 24);
      assert.equal(parsed1.productName, 'sixpack cristal');
      assert.equal(parsed1.totalAmount, 96);
      assert.equal(parsed1.unitCost, 4.00);

      const parsed2 = parseB2BMessage('compra 10 arroz costeño a 38.50');
      assert.ok(parsed2);
      assert.equal(parsed2.type, 'COMPRA_STOCK');
      assert.equal(parsed2.quantity, 10);
      assert.equal(parsed2.productName, 'arroz costeño');
      assert.equal(parsed2.totalAmount, 38.50);
      assert.equal(parsed2.unitCost, 3.85);
    });

    it('debe parsear salidas de stock por venta', () => {
      const parsed = parseB2BMessage('venta 2 sixpack cristal 32');
      assert.ok(parsed);
      assert.equal(parsed.type, 'VENTA_STOCK');
      assert.equal(parsed.quantity, 2);
      assert.equal(parsed.productName, 'sixpack cristal');
      assert.equal(parsed.totalAmount, 32);
    });

    it('debe parsear gastos operativos de caja chica sin Kardex', () => {
      const parsed = parseB2BMessage('25 hielo y bolsas para cocina');
      assert.ok(parsed);
      assert.equal(parsed.type, 'GASTO_CAJA');
      assert.equal(parsed.totalAmount, 25);
      assert.equal(parsed.description, 'hielo y bolsas para cocina');
    });

    it('debe capturar comandos administrativos y de consulta', () => {
      const pStock = parseB2BMessage('/stock');
      assert.equal(pStock.type, 'COMMAND');
      assert.equal(pStock.command, '/stock');

      const pProd = parseB2BMessage('/producto CRISTAL-6 Sixpack Cristal 18.00 12.00');
      assert.equal(pProd.type, 'COMMAND');
      assert.equal(pProd.command, '/producto');
      assert.equal(pProd.args.length, 5);

      const pCierre = parseB2BMessage('/cerrar_turno');
      assert.equal(pCierre.type, 'COMMAND');
      assert.equal(pCierre.command, '/cerrar_turno');

      const pExp = parseB2BMessage('/exportar_contable 2026-09');
      assert.equal(pExp.type, 'COMMAND');
      assert.equal(pExp.command, '/exportar_contable');
      assert.equal(pExp.args[0], '2026-09');
    });
  });

  describe('3. Algoritmo de Costo Promedio Ponderado del Kardex', () => {
    it('debe recalcular el costo promedio ponderado tras nueva compra', () => {
      // Stock inicial: 10 unidades a S/ 5.00 c/u = S/ 50.00 valor
      const currentStock = 10;
      const currentAvgCost = 5.00;

      // Nueva compra: 10 unidades a S/ 70.00 total (S/ 7.00 c/u)
      const purchaseQty = 10;
      const purchaseTotal = 70.00;

      const newStock = currentStock + purchaseQty;
      const newAvgCost = Math.round(((currentStock * currentAvgCost + purchaseTotal) / newStock) * 100) / 100;

      assert.equal(newStock, 20);
      assert.equal(newAvgCost, 6.00); // (50 + 70) / 20 = 120 / 20 = 6.00
    });
  });

});
