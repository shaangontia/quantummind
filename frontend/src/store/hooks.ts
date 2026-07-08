import { useDispatch, useSelector } from 'react-redux';
import type { AppDispatch, RootState } from './store.ts';

export const useAppDispatch = () => useDispatch<AppDispatch>();
export const useAppSelector = <T>(selector: (state: RootState) => T): T =>
  useSelector<RootState, T>(selector);
