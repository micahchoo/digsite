// An example study of the Collection board: six sheets, each one question a
// student of the collection would ask, as regions and connections with
// properties. annotate.ts draws it onto a board load.ts made.
//
// A picture is named by its Art Institute of Chicago artwork id, which
// load.ts keeps as the `aic` property; a slot depends on what the search
// API answered that day. A region is a fraction of its picture
// [fx, fy, fw, fh], measured on a 10% grid over the original. `r` names a
// region within its sheet; an edge end is a region's `r`, or `#<aic>` for
// the whole picture.
type Props = Record<string, string | number>;
type Region = {
  r: string;
  aic: number;
  f: [number, number, number, number];
  label: string;
  props?: Props;
};
type Edge = {
  from: string;
  to: string;
  relation: string;
  direction?: 'none' | 'forward' | 'reverse' | 'both';
  confidence?: 'confirmed' | 'likely' | 'unverified';
  note?: string;
  props?: Props;
};
export type Sheet = {
  name: string;
  pictures: number[];
  regions: Region[];
  edges: Edge[];
};

export const STUDY: Sheet[] = [
  {
    name: 'Names of kings',
    pictures: [
      594, 630, 134010, 134114, 136251, 134549, 133981, 133916, 9790, 133858,
    ],
    regions: [
      {
        r: 'tut3',
        aic: 134010,
        f: [0.57, 0.08, 0.37, 0.88],
        label: 'cartouche',
        props: { reading: 'Men-kheper-Ra', king: 'Thutmose III' },
      },
      {
        r: 'hat',
        aic: 133981,
        f: [0.59, 0.13, 0.37, 0.76],
        label: 'cartouche',
        props: { reading: 'Maat-ka-Ra', king: 'Hatshepsut' },
      },
      {
        r: 'plaque',
        aic: 133858,
        f: [0.6, 0.18, 0.28, 0.6],
        label: 'cartouche',
        props: { reading: 'Men-kheper-ka-Ra', king: 'Thutmose III?' },
      },
      {
        r: 'plaqueBird',
        aic: 133858,
        f: [0.1, 0.18, 0.3, 0.6],
        label: 'bird sign',
        props: { side: 'other face of the plaque' },
      },
      {
        r: 'ses1',
        aic: 133916,
        f: [0.67, 0.25, 0.15, 0.58],
        label: 'cartouche',
        props: { reading: 'Kheper-ka-Ra', king: 'Sesostris I' },
      },
      {
        r: 'ses1Spiral',
        aic: 133916,
        f: [0.56, 0.12, 0.4, 0.84],
        label: 'spiral border',
      },
      {
        r: 'seneb',
        aic: 134114,
        f: [0.23, 0.2, 0.56, 0.55],
        label: 'spiral border',
        props: { name: 'Senebtifi', rank: 'official, not a king' },
      },
      {
        r: 'ring',
        aic: 594,
        f: [0.35, 0.49, 0.38, 0.35],
        label: 'scarab bezel',
        props: { stone: 'green jasper' },
      },
      { r: 'heartA', aic: 630, f: [0.38, 0.6, 0.34, 0.25], label: 'head' },
      { r: 'heartB', aic: 134549, f: [0.4, 0.2, 0.28, 0.13], label: 'head' },
      {
        r: 'late',
        aic: 136251,
        f: [0.21, 0.2, 0.55, 0.62],
        label: 'back',
        props: { base: 'not photographed' },
      },
    ],
    edges: [
      {
        from: 'tut3',
        to: 'plaque',
        relation: 'same king',
        direction: 'none',
        confidence: 'likely',
        note: 'Men-kheper-Ra and Men-kheper-ka-Ra are both written for Thutmose III. The plaque adds a ka sign, which I must check against a sign list.',
        props: { basis: 'throne name' },
      },
      {
        from: 'hat',
        to: 'tut3',
        relation: 'contemporary of',
        direction: 'none',
        confidence: 'confirmed',
        note: 'Hatshepsut and Thutmose III ruled together. The board dates them six years apart (-1473, -1479), which fits.',
        props: { basis: 'co-regency' },
      },
      {
        from: 'ses1Spiral',
        to: 'seneb',
        relation: 'same motif',
        direction: 'none',
        confidence: 'likely',
        note: 'Interlocking spirals round the name on both. Senebtifi is 120 years later, so the border outlived the king.',
        props: { years_apart: 121 },
      },
      {
        from: 'ses1',
        to: 'ring',
        relation: 'same period',
        direction: 'none',
        confidence: 'likely',
        note: 'Both Middle Kingdom, 12th Dynasty: -1991 and -1985.',
      },
      {
        from: 'heartA',
        to: 'heartB',
        relation: 'same type',
        direction: 'none',
        confidence: 'confirmed',
        note: 'Both heart scarabs: larger than the seal scarabs, placed on the chest of the dead. Neither base is shown.',
        props: { type: 'heart scarab' },
      },
      {
        from: 'late',
        to: '#9790',
        relation: 'same period',
        direction: 'none',
        confidence: 'unverified',
        note: 'The plain scarab is dated -304, the first year of Ptolemy I. The Zeus bronze is Ptolemaic too. A date is not a context.',
      },
    ],
  },
  {
    name: 'Heads and reverses',
    pictures: [194522, 9655, 9790, 10006, 182871, 9739, 10019],
    regions: [
      {
        r: 'cleo',
        aic: 194522,
        f: [0.07, 0.13, 0.37, 0.72],
        label: 'portrait',
        props: { side: 'obverse', sitter: 'Cleopatra VII' },
      },
      {
        r: 'antony',
        aic: 194522,
        f: [0.54, 0.13, 0.38, 0.72],
        label: 'portrait',
        props: { side: 'reverse', sitter: 'Mark Antony' },
      },
      {
        r: 'athena',
        aic: 9655,
        f: [0.08, 0.14, 0.37, 0.71],
        label: 'head of a god',
        props: { side: 'obverse', god: 'Athena' },
      },
      {
        r: 'owl',
        aic: 9655,
        f: [0.55, 0.14, 0.37, 0.71],
        label: 'owl',
        props: { side: 'reverse', legend: 'ΑΘΕ' },
      },
      {
        r: 'zeus',
        aic: 9790,
        f: [0.08, 0.17, 0.39, 0.7],
        label: 'head of a god',
        props: { side: 'obverse', god: 'Zeus Ammon' },
      },
      {
        r: 'eagle43',
        aic: 9790,
        f: [0.55, 0.15, 0.36, 0.72],
        label: 'eagle',
        props: { side: 'reverse', stands_on: 'thunderbolt' },
      },
      {
        r: 'demetrius',
        aic: 9739,
        f: [0.09, 0.14, 0.32, 0.76],
        label: 'portrait',
        props: { side: 'obverse', sitter: 'Demetrius II' },
      },
      {
        r: 'eagle49',
        aic: 9739,
        f: [0.59, 0.14, 0.33, 0.76],
        label: 'eagle',
        props: { side: 'reverse', mint: 'Tyre' },
      },
      {
        r: 'hadrianGold',
        aic: 182871,
        f: [0.03, 0.15, 0.39, 0.72],
        label: 'portrait',
        props: { side: 'obverse', sitter: 'Hadrian', metal: 'gold' },
      },
      {
        r: 'hadrianSilver',
        aic: 10019,
        f: [0.12, 0.32, 0.23, 0.46],
        label: 'portrait',
        props: { side: 'obverse', sitter: 'Hadrian', metal: 'silver' },
      },
      {
        r: 'pius',
        aic: 10006,
        f: [0.12, 0.26, 0.23, 0.5],
        label: 'portrait',
        props: { side: 'obverse', sitter: 'Antoninus Pius' },
      },
    ],
    edges: [
      {
        from: 'hadrianGold',
        to: 'hadrianSilver',
        relation: 'same ruler',
        direction: 'none',
        confidence: 'confirmed',
        note: 'Hadrian, bearded, on the gold aureus and the silver denarius. Fourteen years apart on the board (120, 134).',
        props: { ruler: 'Hadrian' },
      },
      {
        from: 'pius',
        to: 'hadrianGold',
        relation: 'successor of',
        direction: 'forward',
        confidence: 'confirmed',
        note: 'Antoninus Pius was adopted by Hadrian and ruled from 138, the date on his aureus.',
      },
      {
        from: 'eagle43',
        to: 'eagle49',
        relation: 'same reverse type',
        direction: 'none',
        confidence: 'likely',
        note: 'An eagle standing on a thunderbolt, the Ptolemaic type, on a Seleucid coin of Tyre. Tyre struck coins for both kingdoms.',
        props: { type: 'eagle on thunderbolt' },
      },
      {
        from: 'cleo',
        to: 'zeus',
        relation: 'same dynasty',
        direction: 'none',
        confidence: 'likely',
        note: 'Cleopatra VII was the last Ptolemy; the Zeus bronze is Ptolemaic Egypt, -117. Her coin was struck in Syria, not Egypt.',
      },
      {
        from: 'cleo',
        to: 'antony',
        relation: 'married to',
        direction: 'none',
        confidence: 'confirmed',
        note: 'One coin, two faces: the queen and Mark Antony, -37.',
      },
      {
        from: 'athena',
        to: 'owl',
        relation: 'emblem of',
        direction: 'reverse',
        confidence: 'confirmed',
        note: "The owl is Athena's bird and the badge of Athens.",
      },
    ],
  },
  {
    name: 'Cats from Peru',
    pictures: [91727, 91580, 91471, 91726, 34164],
    regions: [
      {
        r: 'catA',
        aic: 91727,
        f: [0.19, 0.4, 0.58, 0.32],
        label: 'face',
        props: { eyes: 'painted rings', place: 'Peru' },
      },
      {
        r: 'catB',
        aic: 91726,
        f: [0.23, 0.35, 0.56, 0.44],
        label: 'face',
        props: { eyes: 'painted rings', place: 'Peruvian South Coast' },
      },
      {
        r: 'puma',
        aic: 91580,
        f: [0.17, 0.2, 0.53, 0.5],
        label: 'face',
        props: { animal: 'puma' },
      },
      {
        r: 'collar',
        aic: 91580,
        f: [0.42, 0.5, 0.4, 0.17],
        label: 'collar',
        props: { colour: 'red' },
      },
      {
        r: 'gold',
        aic: 34164,
        f: [0.72, 0.17, 0.17, 0.37],
        label: 'head',
        props: { metal: 'gold' },
      },
      {
        r: 'human',
        aic: 91471,
        f: [0.33, 0.2, 0.3, 0.55],
        label: 'face',
        props: { paint: 'red on one cheek' },
      },
    ],
    edges: [
      {
        from: 'catA',
        to: 'catB',
        relation: 'same mould',
        direction: 'none',
        confidence: 'likely',
        note: 'Same eye rings, same stepped teeth, same ear spacing, both dated 600. One is catalogued "Peru", the other "Peruvian South Coast": probably the same place.',
        props: { to_check: 'culture name: Nasca or Wari?' },
      },
      {
        from: 'puma',
        to: 'catA',
        relation: 'same subject',
        direction: 'none',
        confidence: 'confirmed',
        note: 'Both are feline heads broken off vessels. The puma is 700 years earlier and from the North Coast.',
        props: { years_apart: 700 },
      },
      {
        from: 'gold',
        to: 'puma',
        relation: 'same subject',
        direction: 'none',
        confidence: 'likely',
        note: 'Two North Coast cats: gold, 250, and ceramic, -100.',
      },
      {
        from: 'human',
        to: '#91727',
        relation: 'same form',
        direction: 'none',
        confidence: 'unverified',
        note: 'A head that was part of a vessel, like the cats. Its title leaves "vessel or sculpture" open; the broken lower edge suggests vessel.',
      },
    ],
  },
  {
    name: 'Blazons of Cairo',
    pictures: [15947, 15901, 15876, 15908, 15969],
    regions: [
      {
        r: 'polo',
        aic: 15876,
        f: [0.21, 0.18, 0.54, 0.48],
        label: 'blazon',
        props: { charge: 'polo sticks', colour: 'green on yellow' },
      },
      {
        r: 'fleur',
        aic: 15969,
        f: [0.09, 0.3, 0.22, 0.42],
        label: 'blazon',
        props: { charge: 'fleur-de-lis' },
      },
      {
        r: 'bird15',
        aic: 15901,
        f: [0.25, 0.3, 0.46, 0.38],
        label: 'bird',
        props: { colour: 'cobalt blue on white' },
      },
      { r: 'bird17', aic: 15908, f: [0.28, 0.42, 0.17, 0.2], label: 'bird' },
      { r: 'hare', aic: 15908, f: [0.39, 0.51, 0.41, 0.28], label: 'hare' },
    ],
    edges: [
      {
        from: 'polo',
        to: 'fleur',
        relation: 'same tradition',
        direction: 'none',
        confidence: 'likely',
        note: 'Mamluk blazons of office, both dated 1301. Polo sticks mark the polo master. The fleur-de-lis is a Mamluk blazon here, not a French one.',
        props: { period: 'Mamluk' },
      },
      {
        from: 'bird15',
        to: 'bird17',
        relation: 'same subject',
        direction: 'none',
        confidence: 'confirmed',
        note: 'A bird on both, but 230 years and two wares apart. 15 looks like an imitation of Chinese blue-and-white.',
        props: { years_apart: 230 },
      },
      {
        from: 'hare',
        to: 'bird17',
        relation: 'hunted by',
        direction: 'forward',
        confidence: 'unverified',
        note: "The bird may be a hawk on the hare's back, a hunting scene. The break cuts it off; I cannot see talons.",
      },
    ],
  },
  {
    name: 'What "seal" means',
    pictures: [196481, 6898, 196479, 45081, 45111, 45098, 262422, 91600, 28393],
    regions: [
      {
        r: 'mask63',
        aic: 6898,
        f: [0.14, 0.05, 0.63, 0.3],
        label: 'animal head',
        props: { animal: 'sea lion', filed_as: 'seal (a stamp)' },
      },
      {
        r: 'body104',
        aic: 91600,
        f: [0.14, 0.35, 0.72, 0.52],
        label: 'modelled figures',
        props: {
          reading: 'the "seals" in its title are animals',
          filed_as: 'cylinder seal',
        },
      },
      {
        r: 'loop67',
        aic: 45081,
        f: [0.44, 0.12, 0.16, 0.1],
        label: 'suspension loop',
      },
      {
        r: 'base67',
        aic: 45081,
        f: [0.2, 0.72, 0.6, 0.15],
        label: 'seal base',
        props: { matrix: 'underneath, not shown' },
      },
      {
        r: 'loop69',
        aic: 45111,
        f: [0.38, 0.14, 0.11, 0.13],
        label: 'suspension loop',
      },
      {
        r: 'base69',
        aic: 45111,
        f: [0.25, 0.68, 0.53, 0.16],
        label: 'seal base',
      },
      {
        r: 'loop102',
        aic: 45098,
        f: [0.55, 0.1, 0.14, 0.13],
        label: 'suspension loop',
      },
      {
        r: 'base102',
        aic: 45098,
        f: [0.25, 0.69, 0.49, 0.18],
        label: 'seal base',
        props: { filed_as: 'cylinder seal' },
      },
      {
        r: 'horse62',
        aic: 196481,
        f: [0.3, 0.16, 0.43, 0.52],
        label: 'quadruped',
      },
      {
        r: 'plate62',
        aic: 196481,
        f: [0.35, 0.7, 0.34, 0.15],
        label: 'seal base',
      },
      {
        r: 'horse65',
        aic: 196479,
        f: [0.3, 0.24, 0.28, 0.36],
        label: 'quadruped',
      },
      {
        r: 'plate65',
        aic: 196479,
        f: [0.26, 0.58, 0.46, 0.26],
        label: 'seal base',
      },
    ],
    edges: [
      {
        from: 'mask63',
        to: 'body104',
        relation: 'same animal',
        direction: 'none',
        confidence: 'likely',
        note: 'Both North Coast, both -100, both show the sea lion. They are filed under "seal" and "cylinder seal" only because of the word.',
        props: { vocabulary: 'seal the stamp vs. seal the animal' },
      },
      {
        from: 'base67',
        to: 'base69',
        relation: 'same workshop',
        direction: 'none',
        confidence: 'likely',
        note: 'Chelsea "toys": soft-paste porcelain fob seals, both 1750, same gold mount.',
      },
      {
        from: 'base69',
        to: 'base102',
        relation: 'same workshop',
        direction: 'none',
        confidence: 'likely',
        note: 'Same maker, same date. 102 is filed as a cylinder seal, but it is a fob seal: the matrix is flat, under the base.',
      },
      {
        from: 'loop67',
        to: 'loop102',
        relation: 'same use',
        direction: 'none',
        confidence: 'confirmed',
        note: 'Each hung from a watch chain by this loop.',
      },
      {
        from: 'plate62',
        to: 'plate65',
        relation: 'same type',
        direction: 'none',
        confidence: 'confirmed',
        note: 'Thessalian bronze stamp seals, -800: an animal stands on the stamping plate. Two objects, not one photographed twice; the animals differ.',
        props: {
          note_on_catalogue:
            'one is typed Sculpture, the other Decorative Arts',
        },
      },
      {
        from: '#262422',
        to: '#28393',
        relation: 'same use',
        direction: 'none',
        confidence: 'confirmed',
        note: 'Both hold the red paste a Chinese seal is pressed into. Carved lacquer, 1368; porcelain, 1662.',
      },
    ],
  },
  {
    name: 'Masks and faces',
    pictures: [136740, 212967, 183075, 64312, 22591, 22595],
    regions: [
      {
        r: 'egA',
        aic: 136740,
        f: [0.39, 0.26, 0.23, 0.27],
        label: 'gilded face',
        props: { wig: 'plain blue' },
      },
      {
        r: 'egB',
        aic: 64312,
        f: [0.31, 0.18, 0.33, 0.37],
        label: 'gilded face',
        props: { wig: 'striped blue and gold' },
      },
      {
        r: 'asakura',
        aic: 22591,
        f: [0.25, 0.1, 0.53, 0.72],
        label: 'face',
        props: { character: 'old man' },
      },
      {
        r: 'beard',
        aic: 22591,
        f: [0.38, 0.55, 0.2, 0.3],
        label: 'horsehair beard',
      },
      { r: 'eyes126', aic: 22591, f: [0.27, 0.31, 0.45, 0.09], label: 'eyes' },
      {
        r: 'eyes130',
        aic: 22595,
        f: [0.3, 0.34, 0.42, 0.09],
        label: 'eyes',
        props: { material: 'brass' },
      },
      {
        r: 'mikazuki',
        aic: 22595,
        f: [0.3, 0.54, 0.38, 0.12],
        label: 'moustache',
      },
      {
        r: 'teo',
        aic: 212967,
        f: [0.21, 0.18, 0.58, 0.69],
        label: 'face',
        props: { inlay: 'spondylus shell' },
      },
      {
        r: 'ritual',
        aic: 183075,
        f: [0.11, 0.14, 0.71, 0.55],
        label: 'face',
        props: { surface: 'stone, worn' },
      },
    ],
    edges: [
      {
        from: 'egA',
        to: 'egB',
        relation: 'same type',
        direction: 'none',
        confidence: 'confirmed',
        note: 'Cartonnage with gold leaf, both -100, same catalogue name. Not one mask twice: the wigs differ.',
      },
      {
        from: 'egA',
        to: 'egB',
        relation: 'same workshop',
        direction: 'none',
        confidence: 'unverified',
        note: 'The eyes are outlined the same way. Nothing else to go on yet.',
      },
      {
        from: 'eyes126',
        to: 'eyes130',
        relation: 'same tradition',
        direction: 'none',
        confidence: 'confirmed',
        note: 'Noh masks in Japanese cypress, 200 years apart (1501, 1701). The deity has brass eyes; the old man does not.',
        props: { genre: 'Noh' },
      },
      {
        from: 'teo',
        to: 'ritual',
        relation: 'same style',
        direction: 'none',
        confidence: 'likely',
        note: 'Broad brow, straight nose, open mouth, both 300. 121 is from Teotihuacán; 124 says only "Mexico".',
        props: { to_check: 'is 124 Teotihuacán?' },
      },
    ],
  },
];
