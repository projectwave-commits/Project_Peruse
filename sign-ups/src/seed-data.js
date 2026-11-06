// Starting configuration, taken from the Third Term 2026 option sheets.
// Everything here can be changed afterwards on the staff Setup screen.
// `header` is the column heading used in the Excel export; `slot` is its position
// in the export grid (11 columns per block, left to right).

const SWIM = 'Primary swimmers MUST attend two sessions (1 morning and 1 afternoon).';
const POLO = 'Morning pool training is compulsory. All players must take part in Inter Schools Swimming Galas.';
const TENNIS = 'For competent players only. Non-competent players are encouraged to choose another primary sport.';
const COST = 'Has associated costs, which your coach will communicate.';

const s = (slot, header, name, gender, primary, extra = {}) => ({
  category: 'sport', slot, header, name, gender, is_primary: primary ? 1 : 0, counts_as_club: 0, ...extra,
});
const c = (slot, header, name, extra = {}) => ({
  category: 'club', slot, header, name, is_primary: 0, counts_as_club: 1, ...extra,
});

const OPTIONS = [
  s(0, 'GIRLS SWIMMING', 'Swimming', 'F', true, { note: SWIM }),
  s(1, 'GIRLS WATERPOLO', 'Water Polo', 'F', true, { note: POLO }),
  s(2, 'GIRLS TENNIS', 'Tennis', 'F', true, { note: TENNIS }),
  s(3, 'GIRLS SOCCER', 'Soccer', 'F', false),
  s(4, 'GIRLS CRICKET F1&F2', 'Cricket', 'F', true, { max_form: 2 }),
  s(5, 'GIRLS CROSS TRAINING F3+', 'Senior Mixed Cross Training', 'F', true, { min_form: 3 }),
  s(6, 'BOYS SWIMMING', 'Swimming', 'M', true, { note: SWIM }),
  s(7, 'BOYS WATERPOLO', 'Water Polo', 'M', true, { note: POLO }),
  s(8, 'BOYS TENNIS', 'Tennis', 'M', true, { note: TENNIS }),
  s(9, 'BOYS CRICKET', 'Cricket', 'M', true),
  s(10, 'BOYS CROSS TRAINING F3+', 'Senior Mixed Cross Training', 'M', true, { min_form: 3 }),

  c(0, 'CHOIR', 'Choir'),
  c(1, 'DRAMA', 'Drama'),
  c(2, 'FIRST AID', 'First Aid'),
  c(3, 'SQUASH', 'Squash'),
  c(4, 'VOCAL ENSEMBLE', 'Vocal Ensemble'),
  c(5, 'CHESS (state session A/B/C/D)', 'Chess', {
    sessions: ['A', 'B', 'C', 'D'],
    note: 'Select at least one session that does not clash with your sports or other commitments.',
  }),
  c(6, 'ARCHERY', 'Archery', { note: COST }),
  c(7, 'GOLF', 'Golf', { note: COST }),
  c(8, 'JAZZ BAND', 'Jazz Band'),
  c(9, 'DEBATE', 'Debate'),
  c(10, 'EPD F3+', 'EPD (Elite Physical Development)', {
    min_form: 3,
    counts_as_club: 0,
    by_application: 1,
    note: 'By application only: email Mr Hondo (dhondo@hellenicacademy.ac.zw). You must also choose an alternative club in case you are not accepted. Has associated costs.',
  }),
  c(11, 'BOXING', 'Boxing', {
    counts_as_club: 0,
    note: 'Optional extra: does not count as your club. Has associated costs.',
  }),
  c(12, 'TOAST MASTERS', 'Toast Masters'),
  c(13, 'MARIMBAS', 'Marimbas'),
  c(14, 'QUIZ', 'Quiz'),
  c(15, 'DRONE', 'Drone', { note: 'You must own a drone to attend this club.' }),
  c(16, 'ORCHESTRA', 'Orchestra'),
  c(17, 'STRINGS', 'Strings'),
  c(18, 'BOOK CLUB', 'Book Club'),
  c(19, 'BEGINNER GUITAR', 'Beginner Guitar'),
  c(20, 'COOKERY CLUB F2 ONLY', 'Cookery Club', { min_form: 2, max_form: 2 }),
  c(21, 'ENVIRONMENTAL', 'Environmental'),
  c(22, 'TRIATHLON', 'Triathlon', {
    note: 'You must attend at least 80% of all Zimbabwe Triathlon events in a term.',
  }),
  c(23, 'INTERACT', 'Interact'),
  c(24, 'LIFE DRAWING', 'Life Drawing'),
  c(25, 'TIME TRAVELLERS', 'Time Travellers'),
  c(26, 'WIND BAND', 'Wind Band'),
  c(27, 'MATHS OLYMPIAD F4+', 'Maths Olympiad', { min_form: 4 }),
  c(28, 'MEDIA F4+', 'Media', { min_form: 4, closed: 1 }),
  c(29, 'SOCCER - BOYS', 'Soccer', { gender: 'M' }),
  c(30, 'MUN', 'MUN (Model United Nations)'),
  c(31, 'ROBOTICS', 'Robotics'),
  c(32, 'CRAFTING JNR & SNR', 'Crafting'),
  c(33, 'FLIPSIDE', 'Flipside', {
    counts_as_club: 0,
    note: 'Optional extra: does not count as your club.',
  }),
];

const SPORT_NOTES = [
  '**All pupils must participate in at least one PRIMARY SPORT and one CLUB activity.**',
  'Primary Sports:  Cricket, Tennis, Swimming, Senior Mixed Cross Training, and Water Polo.',
  'If you have two sports that clash, the PRIMARY sport takes precedence over the SECONDARY sport.',
  '',
  'CRICKET SQUAD OF EXCELLENCE - Open to all boys and girls looking to develop their cricket skills. Coaches may also invite selected players. Sign up at the Sports Department Office.',
  'SWIMMING - Pupils who select swimming as their PRIMARY sport MUST attend two sessions (1 Morning & 1 Afternoon).',
  'TENNIS - For competent players only. Non-competent players are encouraged to choose another primary sport.',
  'WATER POLO - Morning pool based training is compulsory. It is compulsory for all Water Polo players to participate in Inter Schools Swimming Galas.',
].join('\n');

const CLUB_NOTES = [
  '**All pupils must select at least one activity from the above CULTURAL timetable.**',
  'ARCHERY, BOXING, GOLF and EPD programs have associated costs, which will be communicated by your coach.',
  'BOXING and FLIPSIDE do not count towards your club allocation but are an optional extra',
  'CHESS - Juniors and Seniors should select a minimum of one session (A/B/C/D) that does not clash with their sports or other commitments.',
  'DRONE - To attend this club pupils must own a drone.',
  'EPD - Elite Physical Development is a strength and conditioning program for aspiring sports pupils and forms part of the High Performance Program. Application from Form 3 upwards by email to Mr Hondo.',
  'TRIATHLON requires pupils to attend a minimum of 80% of all Zimbabwe Triathlon events in a term. Register is taken from the Zimbabwe Triathlon official results table after each event',
].join('\n');

const SETTINGS = {
  school_name: 'HELLENIC ACADEMY',
  term_label: 'THIRD TERM 2026',
  registration_open: '1',
  clash_warnings: '1',
  sport_timetable_url: 'https://drive.google.com/file/d/1oZt3YYfCYzKWZtSH4U-lSUOfWKhORv1W/',
  club_timetable_url: 'https://drive.google.com/file/d/1ZZYddxjLudQ5NPJgwDp1HXsOifG_iBNY/',
  club_admission_note: 'ALL CLUBS RESERVE THE RIGHT OF ADMISSION. You will be asked to leave a club if you mess around in Club Sessions (see more club info below)',
  sport_notes: SPORT_NOTES,
  club_notes: CLUB_NOTES,
};

module.exports = { OPTIONS, SETTINGS };
