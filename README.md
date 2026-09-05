# Valanze B2B 📦 — Kardex, Caja y Pre-Contabilidad vía Telegram
> **Sistema conversacional de control operativo, inventario valorizado y registro de compras para Bodegas, Tiendas de Conveniencia, Retail y Gastronomía.**

Valanze B2B reemplaza los cuadernos de papel y los costosos sistemas ERP de escritorio con un asistente en Telegram que todo el personal puede operar desde su propio celular en menos de 3 segundos, sin ver las ganancias del negocio ni alterar la contabilidad.

---

## 🚀 Características Principales

* 📦 **Kardex de Productos Discretos:** Control de existencias en tiempo real (unidades, six-packs, cajas, sacos) con cálculo automático de **Costo Promedio Ponderado**.
* 🛡️ **Matriz de Roles por Telegram ID:**
  * **Dueño / Administrador:** Ve valorización del inventario, márgenes, caja global, autoriza empleados y descarga los libros contables.
  * **Personal Operativo (Cajero / Cocinero / Almacén):** Solo puede registrar compras, ventas, mermas y conteos físicos. No tiene acceso a reportes financieros.
* 🧾 **Confirmación Estructurada y Clasificación Fiscal Preliminar:**
  * Cada compra genera una tarjeta interactiva con botones: `[📄 Factura con RUC]`, `[🧾 Boleta]`, `[📝 Sin Comprobante]` o `[❌ Cancelar]`.
  * Desglose automático de Base Imponible y Crédito Fiscal (18% IGV) para facilitar la revisión del contador.
* 🏁 **Cuadre de Turno y Arqueo de Caja (`/cerrar_turno`):** Compara en 1 segundo el efectivo físico contado contra el saldo teórico de ventas y gastos.
* 📑 **Exportador Contable con Diccionario de Campos (`/exportar_contable`):** Genera una sábana de trabajo en CSV/Excel compatible con los requerimientos del contador externo (Registro de Compras, Ventas y Kardex).
* 🔒 **Seguridad e Idempotencia:** Protección contra reintentos de red de Telegram (`update_id`) y registro inmutable de auditoría (`audit_logs`).

---

## 🛠️ Despliegue en 5 Minutos (Vercel + Supabase)

### Paso 1: Crear tu Bot de Telegram
1. Abre Telegram y busca a **[@BotFather](https://t.me/BotFather)**.
2. Envía el comando `/newbot` y sigue las instrucciones para asignarle un nombre (ej. `MiBodega_bot`).
3. Copia el **HTTP API Token** generado (lo usarás como `TELEGRAM_BOT_TOKEN`).
4. Abre **[@userinfobot](https://t.me/userinfobot)** para ver tu ID numérico de Telegram (lo usarás como `ADMIN_TELEGRAM_ID`).

### Paso 2: Crear tu Base de Datos en Supabase
1. Ingresa a [Supabase.com](https://supabase.com) y crea un proyecto gratuito.
2. Ve al **SQL Editor** en el panel lateral izquierdo.
3. Copia y pega todo el contenido del archivo [`schema_b2b.sql`](./schema_b2b.sql) y dale clic a **Run**.
4. Ve a **Project Settings** -> **API** y copia tu `Project URL` y `anon public key`.

### Paso 3: Desplegar en Vercel
1. Haz un Fork o clona este repositorio en tu cuenta de GitHub.
2. Importa el repositorio en [Vercel](https://vercel.com).
3. Configura las siguientes **Environment Variables**:
   * `TELEGRAM_BOT_TOKEN`: El token obtenido de @BotFather.
   * `TELEGRAM_SECRET_TOKEN`: Una clave secreta alfanumérica para proteger tu webhook.
   * `SUPABASE_URL`: Tu URL de proyecto en Supabase.
   * `SUPABASE_KEY`: Tu clave pública anónima de Supabase.
   * `ADMIN_TELEGRAM_ID`: Tu ID numérico de Telegram.
4. Haz clic en **Deploy**.
5. Vincula el Webhook ejecutando en tu navegador:
   ```
   https://api.telegram.org/bot<TU_BOT_TOKEN>/setWebhook?url=https://<TU_PROYECTO>.vercel.app/api/webhook&secret_token=<TU_SECRET_TOKEN>
   ```

---

## 📖 Manual de Operaciones y Comandos

### 1. Operativa Diaria del Personal (Mostrador y Cocina)
| Acción | Ejemplo en Telegram | Resultado en el Sistema |
|---|---|---|
| **Comprar Mercadería** | `+24 sixpack cristal 96` | Muestra selector: Factura / Boleta / Sin Sustento. Suma 24 al Kardex y resta S/ 96 de caja. |
| **Vender Producto** | `venta 2 sixpack cristal 32` | Descuenta 2 six-packs del inventario y suma S/ 32 a la caja del turno. |
| **Gasto de Caja Chica** | `25 bolsas y hielo` | Abre selector de comprobante y descuenta S/ 25 de la caja de gaveta. |
| **Consultar Existencias** | `/stock` o `/kardex` | Muestra lista de productos, stock remanente y alertas de stock bajo. |
| **Cierre de Turno** | `/cerrar_turno` | Emite el reporte de efectivo teórico esperado vs ventas digitales (Yape/Plin). |

### 2. Comandos Exclusivos del Administrador (Dueño)
| Comando | Parámetros | Propósito |
|---|---|---|
| `/producto` | `[SKU] [Nombre] [Precio_Venta] [Costo_Base]` | Da de alta un nuevo producto en el catálogo oficial. |
| `/staff` | `[Telegram_ID] [Nombre] [ADMIN o STAFF]` | Autoriza a un empleado para operar el bot. |
| `/balance` | *(Sin parámetros)* | Muestra ventas, egresos, efectivo en gaveta y valor total del stock. |
| `/exportar_contable` | `[YYYY-MM]` (Opcional) | Descarga el archivo de trabajo estructurado para enviar al contador. |

---

## ⚖️ Deslinde y Aviso Regulatorio (SUNAT / Perú)

> [!NOTE]
> **Aviso para Contadores y Contribuyentes:**  
> Valanze B2B es una herramienta de **control operativo interno y captura estructurada de datos**. Los montos de Base Imponible e IGV (18%) calculados en los reportes constituyen una **estimación preliminar** para facilitar la digitación contable. No sustituyen la revisión profesional de los comprobantes de pago ni constituyen una declaración jurada ante la SUNAT. La determinación definitiva de tributos corresponde exclusivamente al contribuyente y a su contador colegiado.

---

## 📄 Licencia

Este proyecto está bajo la Licencia **MIT**. Cualquier empresa o desarrollador puede clonarlo, adaptarlo o redistribuirlo libremente.
