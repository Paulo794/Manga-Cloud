import { CanonicalChapterDto, RawChapterDto, UnclassifiedReason } from './types';

export const FREE_CANONICAL_CHAPTER_LIMIT = 3;

export interface ParsedDecimal {
  normalized: string;
  intPart: string;
  fracPart: string;
  approxNumber: number;
}

/**
 * Normaliza e valida um número decimal não-negativo de forma textual exata (ex.: "0", "01", "2.50" -> "2.5"),
 * evitando perda de precisão de ponto flutuante e suportando capítulo 0 (prólogo).
 */
export function parseDecimalText(raw: string | null | undefined): ParsedDecimal | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return null;
  }
  const [rawInt = '0', rawFrac = ''] = trimmed.split('.');
  const intPart = rawInt.replace(/^0+(?=\d)/, '');
  const fracPart = rawFrac.replace(/0+$/, '');
  const normalized = fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
  const approxNumber = Number(normalized);
  if (!Number.isFinite(approxNumber) || approxNumber < 0) {
    return null;
  }
  return {
    normalized,
    intPart,
    fracPart,
    approxNumber
  };
}

export function compareParsedDecimals(a: ParsedDecimal, b: ParsedDecimal): number {
  if (a.intPart.length !== b.intPart.length) {
    return a.intPart.length - b.intPart.length;
  }
  if (a.intPart !== b.intPart) {
    return a.intPart.localeCompare(b.intPart);
  }
  if (a.fracPart !== b.fracPart) {
    return a.fracPart.localeCompare(b.fracPart);
  }
  return 0;
}

/**
 * Parseia número de capítulo preservando decimais e aceitando capítulo >= 0 (incluindo prólogo "0").
 */
export function parseChapterNumber(raw: string | null | undefined): number | null {
  const parsed = parseDecimalText(raw);
  return parsed ? parsed.approxNumber : null;
}

export function parseVolumeNumber(raw: string | null | undefined): number | null {
  const parsed = parseDecimalText(raw);
  return parsed ? parsed.approxNumber : null;
}

/**
 * Ordena candidatos de tradução equivalente (mesmo volume explícito + mesmo capítulo decimal):
 * 1) maior número de páginas;
 * 2) ID em ordem alfabética (100% determinístico, nunca por data de upload).
 */
function compareTranslationCandidates(a: RawChapterDto, b: RawChapterDto): number {
  if (a.pagesCount !== b.pagesCount) {
    return b.pagesCount - a.pagesCount;
  }
  return a.id.localeCompare(b.id);
}

interface CanonicalGroup {
  volumeDecimal: ParsedDecimal | null;
  chapterDecimal: ParsedDecimal;
  candidates: RawChapterDto[];
}

function compareCanonicalGroups(a: CanonicalGroup, b: CanonicalGroup): number {
  // F1-07: Ordenação lexicográfica estrita e transitiva (strict weak ordering):
  // 1) Capítulos com volume explícito vêm antes de capítulos sem volume (NULLS LAST);
  // 2) Quando ambos têm volume, ordena por volume crescente;
  // 3) Ordena por número de capítulo decimal crescente;
  // 4) Desempata pelo menor ID determinístico do grupo.
  if (a.volumeDecimal !== null && b.volumeDecimal === null) {
    return -1;
  }
  if (a.volumeDecimal === null && b.volumeDecimal !== null) {
    return 1;
  }
  if (a.volumeDecimal !== null && b.volumeDecimal !== null) {
    const volCmp = compareParsedDecimals(a.volumeDecimal, b.volumeDecimal);
    if (volCmp !== 0) {
      return volCmp;
    }
  }

  const chCmp = compareParsedDecimals(a.chapterDecimal, b.chapterDecimal);
  if (chCmp !== 0) {
    return chCmp;
  }

  const firstIdA = a.candidates[0]?.id ?? '';
  const firstIdB = b.candidates[0]?.id ?? '';
  return firstIdA.localeCompare(firstIdB);
}

/**
 * Calcula a posição canônica global sobre todos os capítulos de uma obra/idioma (REV-08 / F1-01):
 * - Preserva volumes distintos: capítulos de volumes diferentes (ex.: vol 1 cap 1 e vol 2 cap 1)
 *   NUNCA são fundidos como traduções alternativas.
 * - Só agrupa traduções equivalentes quando compartilham o mesmo volume explícito E o mesmo capítulo decimal.
 *   Entradas com volume ausente/desconhecido (volumeNumber = null) não são deduplicadas automaticamente.
 * - As 3 primeiras posições canônicas (canonicalPosition <= 3) têm isEligibleForFree = true.
 */
export function canonicalizeChapters(rawChapters: RawChapterDto[]): CanonicalChapterDto[] {
  const numericGroups = new Map<string, CanonicalGroup>();
  const unclassified: Array<{ chapter: RawChapterDto; reason: UnclassifiedReason; numericChapter: number | null }> = [];

  for (const ch of rawChapters) {
    const parsedChapter = parseDecimalText(ch.chapterNumber);
    const parsedVolume = parseDecimalText(ch.volumeNumber);
    const isExternalOnly = Boolean(ch.externalUrl) || ch.pagesCount <= 0;

    if (isExternalOnly) {
      unclassified.push({
        chapter: ch,
        reason: 'EXTERNAL_CHAPTER_ONLY',
        numericChapter: parsedChapter ? parsedChapter.approxNumber : null
      });
      continue;
    }

    if (parsedChapter === null) {
      unclassified.push({
        chapter: ch,
        reason: 'UNCLASSIFIED_CHAPTER',
        numericChapter: null
      });
      continue;
    }

    // F1-01: Identidade lógica preserva volumes distintos e não deduplica entradas sem volume explícito
    const groupKey =
      parsedVolume !== null
        ? `vol:${parsedVolume.normalized}#ch:${parsedChapter.normalized}`
        : `novol:${ch.id}#ch:${parsedChapter.normalized}`;

    const existing = numericGroups.get(groupKey);
    if (existing) {
      existing.candidates.push(ch);
    } else {
      numericGroups.set(groupKey, {
        volumeDecimal: parsedVolume,
        chapterDecimal: parsedChapter,
        candidates: [ch]
      });
    }
  }

  // Ordenar candidatos de cada grupo ANTES de ordenar os grupos para que candidates[0].id seja invariante à ordem de entrada
  for (const group of numericGroups.values()) {
    group.candidates.sort(compareTranslationCandidates);
  }

  const sortedGroups = Array.from(numericGroups.values()).sort(compareCanonicalGroups);
  const result: CanonicalChapterDto[] = [];

  sortedGroups.forEach((group, index) => {
    const canonicalPosition = index + 1;
    const isEligibleForFree = canonicalPosition <= FREE_CANONICAL_CHAPTER_LIMIT;
    const sortedCandidates = group.candidates;
    const primary = sortedCandidates[0]!;
    const alternates = sortedCandidates.slice(1).map((alt) => ({
      id: alt.id,
      title: alt.title,
      volumeNumber: alt.volumeNumber,
      chapterNumber: alt.chapterNumber,
      language: alt.language,
      scanlationGroup: alt.scanlationGroup,
      pagesCount: alt.pagesCount,
      publishedAt: alt.publishedAt
    }));

    result.push({
      ...primary,
      canonicalPosition,
      numericChapter: group.chapterDecimal.approxNumber,
      isEligibleForFree,
      unclassifiedReason: null,
      alternateTranslations: alternates
    });
  });

  unclassified
    .sort((a, b) => a.chapter.id.localeCompare(b.chapter.id))
    .forEach(({ chapter, reason, numericChapter }) => {
      result.push({
        ...chapter,
        canonicalPosition: null,
        numericChapter,
        isEligibleForFree: false,
        unclassifiedReason: reason,
        alternateTranslations: []
      });
    });

  return result;
}

/**
 * Localiza um capítulo pelo chapterId dentro da lista canônica (incluindo traduções alternativas),
 * preservando os metadados próprios da versão alternativa (F1-01).
 */
export function findCanonicalChapterById(
  canonicalList: CanonicalChapterDto[],
  chapterId: string
): {
  chapter: CanonicalChapterDto;
  prevChapterId: string | null;
  nextChapterId: string | null;
} | null {
  const readableCanonical = canonicalList.filter((c) => c.canonicalPosition !== null);

  for (const item of canonicalList) {
    const isPrimary = item.id === chapterId;
    const matchingAlt = item.alternateTranslations.find((alt) => alt.id === chapterId);

    if (isPrimary || matchingAlt) {
      const resolvedChapter: CanonicalChapterDto = matchingAlt
        ? {
            ...item,
            id: matchingAlt.id,
            title: matchingAlt.title,
            volumeNumber: matchingAlt.volumeNumber,
            chapterNumber: matchingAlt.chapterNumber,
            language: matchingAlt.language,
            scanlationGroup: matchingAlt.scanlationGroup,
            pagesCount: matchingAlt.pagesCount,
            publishedAt: matchingAlt.publishedAt
          }
        : item;

      const idxInReadable = readableCanonical.findIndex(
        (c) => c.canonicalPosition === item.canonicalPosition && item.canonicalPosition !== null
      );
      const prevChapterId = idxInReadable > 0 ? readableCanonical[idxInReadable - 1]?.id ?? null : null;
      const nextChapterId =
        idxInReadable >= 0 && idxInReadable < readableCanonical.length - 1
          ? readableCanonical[idxInReadable + 1]?.id ?? null
          : null;

      return {
        chapter: resolvedChapter,
        prevChapterId,
        nextChapterId
      };
    }
  }

  return null;
}
