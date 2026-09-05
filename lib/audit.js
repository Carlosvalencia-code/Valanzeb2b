/**
 * Valanze B2B — Módulo de Auditoría y Trazabilidad Inmutable
 */

export async function logAuditEvent(supabase, { action, entity, entityId, details, userId }) {
  if (!supabase) return;
  try {
    await supabase.from('audit_logs').insert([{
      action,
      entity,
      entity_id: entityId ? entityId.toString() : null,
      details: details || {},
      user_id: userId
    }]);
  } catch (error) {
    console.error('Error registrando auditoría:', error);
  }
}
