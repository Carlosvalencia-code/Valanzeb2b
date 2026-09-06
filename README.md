# Valanze B2B 📦 — Kardex, Control de Caja y Pre-Contabilidad vía Telegram

[![Node.js](https://img.shields.io/badge/Node.js-20.x-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Tests: Passing](https://img.shields.io/badge/Tests-7%2F7%20Passing-brightgreen.svg)](./test/b2b_flow.test.js)
[![Vercel Serverless](https://img.shields.io/badge/Deploy-Vercel-black.svg)](https://vercel.com)
[![Database: Supabase](https://img.shields.io/badge/Database-Supabase%20Postgres-emerald.svg)](https://supabase.com)

> **Sistema open-source de control operativo, inventario valorizado (Kardex) y preparación de compras para Bodegas, Tiendas de Conveniencia, Retail y Gastronomía de productos discretos.**

---

## 🎯 1. ¿Qué es este proyecto y qué problema resuelve?

En América Latina (y particularmente en el Perú), más de **680,000 microempresas** comerciales y gastronómicas operan bajo una enorme fricción diaria:

1. **El fracaso del software tradicional en el mostrador:** Los sistemas ERP y puntos de venta (POS) tradicionales exigen laptops o terminales de $80/mes que no sobreviven al ajetreo de un mostrador con clientes en cola ni a una cocina con manos mojadas. Los cuadernos de papel se pierden y las hojas de Excel se abandonan al tercer día.
2. **La fuga hormiga y el descontrol de inventario:** El 22% de los pequeños negocios quiebra por no saber cuánta mercadería tienen en almacén ni a qué costo promedio la compraron.
3. **El dolor de cabeza tributario a fin de mes:** Los comprobantes de compras en mercados mayoristas o distribuidores llegan arrugados en bolsas de plástico. El contador externo pasa días digitando manualmente o el negocio pierde el **crédito fiscal del IGV (18%)** por falta de sustento ordenado.

**Valanze B2B** resuelve este problema llevando todo el control a **Telegram**: una herramienta que todo el personal ya tiene instalada en su celular, funciona con planes mínimos de datos y permite registrar compras, ventas y gastos en **menos de 3 segundos sin revelar las ganancias del negocio a los empleados**.

---

## 🔍 2. Alcance e Implicancias Operativas

### A) Inventario de Productos Discretos (Kardex Ponderado)
El sistema está diseñado para controlar productos que se adquieren y venden directamente por unidad o bulto:
* **Bebidas y Licores:** Cervezas, gaseosas, aguas, energizantes, botellas de vino/pisco.
* **Abarrotes y Empaquetados:** Sacos de arroz/azúcar, bidones de aceite, snacks, golosinas, conservas, artículos de limpieza.
* **Insumos gastronómicos cerrados:** Cajas de lácteos, embutidos sellados, insumos por kilo entero.

Cada compra recalcula automáticamente el **Costo Promedio Ponderado** del inventario en PostgreSQL:
$$\text{Nuevo Costo Promedio} = \frac{(\text{Stock Actual} \times \text{Costo Anterior}) + \text{Monto de Compra}}{\text{Stock Actual} + \text{Cantidad Comprada}}$$

### B) Matriz de Roles y Seguridad por Telegram ID
* **Administrador / Dueño:** Acceso total a márgenes de ganancia, valor total de inventario en soles, cuadre de caja global, gestión de empleados y exportación contable.
* **Personal Operativo (Cajeros, Cocineros, Almacén):** Solo pueden registrar entradas, ventas y consultar existencias. El sistema bloquea automáticamente comandos financieros como `/balance` o `/excel`.

### C) Tarjetas Interactivas de Clasificación Fiscal
Al registrar una compra (ej. `+24 sixpack cristal 96`), el bot no asume datos a ciegas; despliega botones interactivos:
`[📄 Factura con RUC]` `[🧾 Boleta]` `[📝 Sin Comprobante]` `[❌ Cancelar]`
* Si se marca **Factura**, desglosa automáticamente la **Base Imponible** ($Total / 1.18$) y el **IGV preliminar (18%)** para el Registro de Compras del contador.

---

## ⚠️ 3. Limitaciones Conocidas y Fronteras del Proyecto

Para mantener transparencia técnica y regulatoria, este proyecto define claramente lo que **NO** hace:

1. **No es un facturador electrónico directo ante SUNAT:** Valanze B2B no emite Comprobantes de Pago Electrónicos (CPE) ni está conectado como OSE/PSE. Funciona como un **sistema de control interno y pre-contabilidad**.
2. **No maneja recetas con despiece dinámico en el MVP:** Para evitar inconsistencias de stock en esta primera versión, no descuenta gramos de sal o mililitros de salsa por cada plato servido. Las recetas gastronómicas complejas están proyectadas para la Fase 2.
3. **Cálculos tributarios preliminares:** La separación de Base e IGV generada por el bot constituye una **propuesta matemática de trabajo** para el contador colegiado. No sustituye la auditoría tributaria ni garantiza crédito fiscal sin comprobante físico/electrónico válido ante la ley.
4. **Dependencia de la plataforma Telegram:** Requiere conexión a internet (vía datos móviles o Wi-Fi) y una cuenta activa de Telegram.

---

## 🏛️ 4. Arquitectura Técnica y Modelo de Seguridad

```
                   ┌─────────────────────────────────────────┐
                   │           Telegram Cloud API            │
                   └────────────────────┬────────────────────┘
                                        │ Webhook HTTPS (POST)
                                        │ x-telegram-bot-api-secret-token
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Vercel Serverless Function                            │
│                                                                             │
│  api/webhook.js ──► [Idempotency Guard] ──► lib/botLogic.js                 │
│                      (update_id deduplication)  │                            │
│                                                 ├──► lib/parser.js (NLP)     │
│                                                 └──► lib/exportAccounting.js │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Supabase Client (SSL)
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Supabase PostgreSQL Database                             │
│                                                                             │
│  • business_users (Roles)        • kardex_movements (Stock audit)           │
│  • products_catalog (Inventory)  • cash_transactions (Vouchers & IGV)       │
│  • audit_logs (Immutable audit)  • RPC: get_kardex_valuation()              │
└─────────────────────────────────────────────────────────────────────────────┘
```

* **Idempotencia contra Fallos de Red:** Si Telegram reintenta enviar un webhook por micro-cortes de red, la tabla `webhook_idempotency` detecta el `update_id` duplicado y previene registros dobles de dinero o stock.
* **Auditoría Inmutable:** Cada creación, venta, ajuste o reverso de transacción queda sellada en la tabla `audit_logs` con el Telegram ID y marca de tiempo exacta.
* **Zero Service Key en el Cliente:** Todo el acceso a la base de datos se realiza bajo políticas protegidas sin exponer secretos en el cliente.

---

## 🚀 5. Guía de Instalación Rápida (5 Minutos)

### Paso 1: Crear el Bot en Telegram
1. Abre Telegram y conversa con **[@BotFather](https://t.me/BotFather)**.
2. Ejecuta `/newbot` y obtén tu **HTTP API Token**.
3. Consulta tu ID numérico personal en **[@userinfobot](https://t.me/userinfobot)** (será tu `ADMIN_TELEGRAM_ID`).

### Paso 2: Base de Datos en Supabase
1. Crea un proyecto gratuito en [Supabase](https://supabase.com).
2. Ve al **SQL Editor** y pega todo el contenido de [`schema_b2b.sql`](./schema_b2b.sql). Dale a **Run**.
3. En **Project Settings -> API**, copia la `Project URL` y la `anon public key`.

### Paso 3: Desplegar en Vercel
1. Haz un Fork o clona este repositorio e impórtalo en [Vercel](https://vercel.com).
2. Agrega las siguientes **Environment Variables**:
   ```env
   TELEGRAM_BOT_TOKEN=tu-bot-token-de-botfather
   TELEGRAM_SECRET_TOKEN=tu-clave-secreta-alfanumerica
   SUPABASE_URL=https://tu-proyecto.supabase.co
   SUPABASE_KEY=tu-anon-key-de-supabase
   ADMIN_TELEGRAM_ID=tu-id-numerico-de-telegram
   ```
3. Haz clic en **Deploy**.

### Paso 4: Activar el Webhook
Abre tu navegador y entra a:
```text
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<TU_DOMINIO_VERCEL>/api/webhook&secret_token=<TELEGRAM_SECRET_TOKEN>
```
Deberás recibir: `{"ok":true,"result":true,"description":"Webhook was set"}`.

---

## 📋 6. Manual de Uso y Comandos

### Para el Personal Operativo (Cajeros, Almacén, Mostrador)
| Operación | Ejemplo en Chat | Acción del Bot |
|---|---|---|
| **Comprar Mercadería** | `+24 sixpack cristal 96` | Abre selector de comprobante. Suma 24 al stock y descuenta S/ 96 de caja. |
| **Vender Producto** | `venta 2 sixpack cristal` | Descuenta 2 sixpacks del inventario y suma el precio de venta a la caja. |
| **Gasto de Caja Chica** | `15 pasajes mercado` | Registra salida de caja chica con opción a comprobante. |
| **Consultar Stock** | `/stock` | Muestra existencias actuales y alertas de poco stock. |
| **Cuadre de Caja** | `/caja` o `/cierre` | Muestra el total de ventas y el dinero que debe haber en gaveta. |

### Para el Dueño / Administrador
| Comando | Formato | Propósito |
|---|---|---|
| `/producto` | `/producto [Código] [Nombre] [Precio] [Costo]` | Agrega un nuevo producto al catálogo oficial. |
| `/equipo` | `/equipo [ID_Telegram] [Nombre] [STAFF o ADMIN]` | Otorga permiso a un empleado para operar el bot. |
| `/balance` | *(Sin parámetros)* | Resumen de ventas totales, egresos, caja neta y valor del inventario. |
| `/excel` | `/excel [YYYY-MM]` *(Opcional)* | Descarga la sábana estructurada en CSV/Excel para el contador. |

---

## 🗺️ 7. Hoja de Ruta (Roadmap)

- [x] **Fase 1 (Actual):** Kardex de productos discretos, cuadre de caja chica, matriz de roles, idempotencia y exportación contable.
- [ ] **Fase 2:** Módulo de recetas gastronómicas (descuento automático de insumos al vender platos preparados).
- [ ] **Fase 3:** Transcripción de notas de voz con IA (Whisper) y escaneo OCR de fotos de comprobantes físicos.
- [ ] **Fase 4:** Panel web multi-sucursal para cadenas y franquicias.

---

## ⚖️ 8. Deslinde Legal y Regulatorio (SUNAT / Perú)

> **Aviso para Contadores y Contribuyentes:**  
> Valanze B2B es un software de **organización operativa interna**. Los montos de Base Imponible y Crédito Fiscal de IGV calculados en los reportes son estimaciones matemáticas basadas en la información proporcionada por los usuarios. No sustituyen los libros electrónicos oficiales de SUNAT (SIRE) ni garantizan la deducibilidad tributaria sin la validación de comprobantes físicos o electrónicos válidos conforme a ley.

---

## 📄 9. Licencia

Distribuido bajo la Licencia **MIT**. Consulta el archivo `LICENSE` para más información.
