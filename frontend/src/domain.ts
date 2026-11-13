export interface Subscription {
  plano: string;
  isPro: boolean;
  status: string;
  inadimplente?: boolean;
  hasBillingAccount?: boolean;
  acessoAte: string | null;
  cancelAtPeriodEnd: boolean;
  canManageRenewal: boolean;
  limits?: { estantesFree: number; capitulosDemoFree: number };
}
export interface User {
  id: number;
  nome: string;
  email: string;
  role: string;
  bio: string | null;
  avatar_url: string | null;
  plano?: string;
  assinaturaStatus?: string;
  inadimplente?: boolean;
  assinatura: Subscription;
}
export interface AdminMetrics {
  totalUsuarios: number;
  usuariosPorPlano: { free: number; pro: number };
  assinaturasAtivas: number;
  assinaturasPorStatus: { ativas: number; inadimplentes: number; cancelamentoAgendado: number; canceladas: number };
  precoProCentavos: number;
  mrrCentavos: number;
}
export interface AuditEventItem {
  id: string;
  usuario_id: number | null;
  acao: string;
  recurso?: string;
  resultado: string;
  timestamp?: string;
  detalhe?: Record<string, unknown>;
}
export interface Manga { provider: string; id: string; title: string; synopsis: string; coverUrl: string | null; status: string; availableLanguages: string[]; tags: { id: string; name: string }[]; authors?: string[]; isDemo: boolean; }
export interface Shelf { id: number; nome: string; descricao: string | null; totalItens?: number; possuiCapa?: boolean; capa?: { mime_type: string; largura_px: number; altura_px: number } | null; }
export interface Reference { id: number; provider: string; manga_id: string; metadataAvailable: boolean; manga: Manga | null; chapter_id?: string; pagina?: number; revisao?: number; idioma?: string; ordem?: number; }
export interface Chapter { id: string; title: string; chapterNumber: string | null; volumeNumber: string | null; canonicalPosition: number | null; externalUrl: string | null; liberadoParaUsuarioAtual: boolean; bloqueadoParaFree: boolean; unclassifiedReason: string | null; scanlationGroup: string; }
export interface Manifest { provider: string; mangaId: string; chapterId: string; language: string; title: string; totalPages: number; pages: { pageNumber: number; imageUrl: string }[]; prevChapterId: string | null; nextChapterId: string | null; isDemo: boolean; }
export interface Page<T> { items: T[]; total?: number; page?: number; limit?: number; }
export function errorMessage(error: unknown): string {
  const e = error as { response?: { data?: { message?: string; error?: string } }; message?: string };
  return e?.response?.data?.message || e?.response?.data?.error || 'Não foi possível concluir. Tente novamente.';
}
