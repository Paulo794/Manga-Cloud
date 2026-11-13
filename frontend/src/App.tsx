import type { ReactNode } from 'react';
import { BrowserRouter, Routes, Route, Navigate, NavLink, Link, useNavigate } from 'react-router-dom';
import { SessionProvider } from './context/SessionProvider';
import { useSession } from './hooks/useSession';
import { Notice } from './components/Common';
import Landing from './pages/Landing';
import Catalog from './pages/Catalog';
import Login from './pages/Login';
import Work from './pages/Work';
import Reader from './pages/Reader';
import { Shelves, ShelfDetail } from './pages/Shelves';
import { References, Profile, Plans } from './pages/Account';
import { Admin, Curator } from './pages/Admin';
import Recovery from './pages/Recovery';
function Protected({ children, roles }: { children: ReactNode; roles?: string[] }) {
  const { user, loading } = useSession();
  if (loading) return <Notice>Verificando sessão…</Notice>;
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <Notice error>Seu papel não permite acessar esta página.</Notice>;
  return children;
}
function Shell() {
  const { user, logout } = useSession(), navigate = useNavigate();
  return <><header className="site-header"><Link className="brand" to="/" aria-label="MangaCloud início"><span className="brand-icon">M<span>↗</span></span>MANGA<span>CLOUD</span></Link><nav aria-label="Navegação principal"><NavLink to="/catalogo">Explorar</NavLink>{user && <><NavLink to="/estantes">Estantes</NavLink><NavLink to="/favoritos">Favoritos</NavLink><NavLink to="/historico">Histórico</NavLink></>}<NavLink to="/assinatura">Planos</NavLink>{user && ['curador', 'admin'].includes(user.role) && <NavLink to="/curadoria">Curadoria</NavLink>}{user?.role === 'admin' && <NavLink to="/admin">Admin</NavLink>}</nav><div className="header-account">{user ? <><Link to="/perfil">{user.nome.split(' ')[0]}</Link><button onClick={() => { logout(); navigate('/login', { replace: true }); }}>Sair</button></> : <Link className="button dark" to="/login">Entrar ↗</Link>}</div></header><main>{user?.assinatura?.inadimplente && <Notice error>A cobrança de renovação da sua assinatura falhou (assinatura inadimplente). Seu acesso voltou para o plano Free até a regularização. <Link to="/assinatura">Gerenciar assinatura →</Link></Notice>}<Routes>
    <Route path="/" element={<Landing />} /><Route path="/login" element={<Login />} /><Route path="/forgot-password" element={<Recovery />} /><Route path="/reset-password" element={<Recovery reset />} />
    <Route path="/catalogo" element={<Catalog />} /><Route path="/mangas/:provider/:mangaId" element={<Work />} />
    <Route path="/estantes" element={<Protected><Shelves /></Protected>} /><Route path="/estantes/:id" element={<Protected><ShelfDetail /></Protected>} />
    <Route path="/leitura/:provider/:chapterId" element={<Protected><Reader /></Protected>} />
    <Route path="/favoritos" element={<Protected><References /></Protected>} /><Route path="/historico" element={<Protected><References history /></Protected>} /><Route path="/perfil" element={<Protected><Profile /></Protected>} />
    <Route path="/assinatura" element={<Plans />} /><Route path="/sucesso" element={<Protected><Plans success /></Protected>} />
    <Route path="/curadoria" element={<Protected roles={['curador', 'admin']}><Curator /></Protected>} /><Route path="/admin" element={<Protected roles={['admin']}><Admin /></Protected>} />
    <Route path="/catalog" element={<Navigate to="/catalogo" replace />} /><Route path="/profile" element={<Navigate to="/perfil" replace />} /><Route path="/success" element={<Navigate to="/sucesso" replace />} /><Route path="/cancel" element={<Navigate to="/assinatura" replace />} />
    <Route path="*" element={<section><h1>Página não encontrada.</h1><Link to="/">Voltar ao início</Link></section>} />
  </Routes></main><footer className="site-footer"><Link className="brand" to="/">MANGA<span>CLOUD</span></Link><p>Histórias para explorar. Uma biblioteca para chamar de sua.</p><small>Projeto acadêmico ISW055 · MangaDex e grupos de tradução mantêm os créditos de suas obras. Catálogo Demo identificado.</small></footer></>;
}
export default function App() { return <BrowserRouter><SessionProvider><Shell /></SessionProvider></BrowserRouter>; }
