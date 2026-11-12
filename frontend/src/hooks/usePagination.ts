import { useSearchParams } from 'react-router-dom';

export function usePagination(parameter = 'page') {
  const [params, setParams] = useSearchParams();
  const supplied = Number(params.get(parameter) || 1);
  const page = Number.isSafeInteger(supplied) && supplied >= 1 && supplied <= 10000 ? supplied : 1;
  const setPage = (value: number) => {
    const next = new URLSearchParams(params); next.set(parameter, String(value)); setParams(next);
  };
  return { page, setPage };
}
