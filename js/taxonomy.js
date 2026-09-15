// Closed vocabularies used by chips, selects and filters.
// `label` is what the UI shows (Spanish); `ko` is a short Korean gloss for the learner.

export const TYPES = [
  { id: 'locucion', label: 'locución', ko: '관용구' },
  { id: 'colocacion', label: 'colocación', ko: '연어' },
  { id: 'refran', label: 'refrán', ko: '속담' },
  { id: 'marcador', label: 'marcador', ko: '담화표지' },
  { id: 'falso_amigo', label: 'falso amigo', ko: '가짜 친구' },
  { id: 'verbo_prep', label: 'verbo + prep.', ko: '동사+전치사' },
  { id: 'variante', label: 'variante', ko: '지역 변이형' },
  { id: 'expresion', label: 'expresión', ko: '표현' },
  { id: 'lexico', label: 'léxico', ko: '어휘' },
  { id: 'estructura', label: 'estructura', ko: '구문' },
  { id: 'otro', label: 'otro', ko: '기타' },
];

export const REGISTERS = [
  { id: 'culto', label: 'culto', ko: '격식체' },
  { id: 'neutro', label: 'neutro', ko: '중립' },
  { id: 'coloquial', label: 'coloquial', ko: '구어체' },
  { id: 'vulgar', label: 'vulgar', ko: '비속어' },
];

export const REGIONS = [
  { id: 'ES', label: 'ES', ko: '스페인' },
  { id: 'MX', label: 'MX', ko: '멕시코' },
  { id: 'AR', label: 'AR', ko: '아르헨티나' },
  { id: 'CO', label: 'CO', ko: '콜롬비아' },
  { id: 'RioPlata', label: 'RioPlata', ko: '리오플라타' },
  { id: 'general', label: 'general', ko: '범용' },
];

export const STATUSES = [
  { id: 'active', label: 'activa', ko: '학습 중' },
  { id: 'inbox', label: 'bandeja', ko: '대기함' },
  { id: 'suspended', label: 'suspendida', ko: '보류' },
];

export const DIRECTIONS = [
  { id: 'both', label: 'ambas', ko: '양방향' },
  { id: 'rec', label: 'reconocimiento', ko: '인식' },
  { id: 'prod', label: 'producción', ko: '산출' },
];

export const SUGGESTED_TEMAS = [
  'tema:ciencia_tecnologia',
  'tema:medio_ambiente',
  'tema:economia_trabajo',
  'tema:politica_sociedad',
  'tema:educacion',
  'tema:salud',
  'tema:cultura_arte',
  'tema:medios',
  'tema:historia',
  'tema:relaciones',
  'tema:lengua_literatura',
  'tema:justicia',
  'tema:ciudad_viajes',
  'tema:consumo',
  'prueba:1',
  'prueba:2',
  'prueba:3',
];

export const TYPE_IDS = TYPES.map((t) => t.id);
export const REGISTER_IDS = REGISTERS.map((r) => r.id);
export const STATUS_IDS = STATUSES.map((s) => s.id);
export const DIRECTION_IDS = DIRECTIONS.map((d) => d.id);

/** Spanish label for a type id ('locucion' -> 'locución'); falls back to the id itself. */
export function typeLabel(id) {
  const t = TYPES.find((x) => x.id === id);
  return t ? t.label : String(id || '');
}
