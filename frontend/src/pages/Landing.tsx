import { Link } from 'react-router-dom';
import { MangaCard } from '../components/Common';
import { useLoad } from '../hooks/useLoad';
import type { Manga, Page } from '../domain';
export default function Landing() {
  const { data } = useLoad<Page<Manga>>('/mangas?provider=demo&limit=3');
  return <>
    <section className="hero"><div className="hero-copy"><span className="eyebrow">SUA BIBLIOTECA, EM OUTRA DIMENSÃO</span><h1>Mais histórias.<br /><em>Do seu jeito.</em></h1><p>Descubra mangás, monte suas estantes e encontre seu próximo capítulo. Um espaço só seu para organizar a vontade de ler.</p><div className="actions"><Link className="button primary" to="/catalogo">Explorar mangás ↗</Link><Link className="button" to="/login?cadastro=1">Criar minha biblioteca</Link></div><small>Projeto acadêmico · Catálogo MangaDex e demonstração identificada</small></div><div className="hero-art" aria-hidden="true"><span className="comic-stamp">LEIA.<br />EXPLORE.<br />REPITA.</span><div className="comic-panel panel-one">UM NOVO<br /><strong>CAPÍTULO</strong></div><div className="comic-panel panel-two">COMEÇA<br /><strong>AQUI ↗</strong></div><span className="orbit">✦</span></div></section>
    <section><div className="section-heading"><div><span className="eyebrow">COMO FUNCIONA</span><h2>Seu universo de leitura.</h2></div></div><div className="feature-grid"><article><span>01 / DESCUBRA</span><h3>Uma história para cada fase.</h3><p>Busque na fonte externa e escolha o idioma disponível para ler.</p></article><article><span>02 / ORGANIZE</span><h3>Estantes com a sua cara.</h3><p>Crie listas privadas, adicione suas obras e envie uma capa personalizada.</p></article><article><span>03 / LEIA</span><h3>Só mais um capítulo.</h3><p>Abra as páginas no leitor web, sem precisar baixar o acervo.</p></article></div></section>
    <section><div className="section-heading"><div><span className="eyebrow">EXPERIMENTE O MANGACLOUD</span><h2>Histórias do nosso laboratório.</h2><p>Obras sintéticas para conhecer o leitor e testar os recursos.</p></div><Link to="/catalogo?provider=demo">Ver demonstração →</Link></div><div className="manga-grid">{data?.items.map(m => <MangaCard key={m.id} manga={m} />)}</div></section>
  </>;
}
