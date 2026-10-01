/** CS21-3: /api/agent-settings 的 schema.llmFormats 共享形状——
 * 两页(设置页/agent 配置页签)与编辑器组件统一必选口径。 */
export interface LlmFormatMeta {
  id: string;
  label: string;
  hint: string;
}
