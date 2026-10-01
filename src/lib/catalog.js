// Sample garments shipped with the app (public/garments).
export const CATALOG = [
  { id: 'tee-coral', name: 'Coral Crew Tee', type: 'top', price: 24, file: 'garments/tee-coral.svg' },
  { id: 'tee-graphic', name: 'Golden Hour Tee', type: 'top', price: 32, file: 'garments/tee-graphic.svg' },
  { id: 'breton-longsleeve', name: 'Breton Long Sleeve', type: 'top', price: 45, file: 'garments/breton-longsleeve.svg' },
  { id: 'hoodie-grey', name: 'Heather Hoodie', type: 'top', price: 58, file: 'garments/hoodie-grey.svg' },
  { id: 'oxford-shirt', name: 'Oxford Shirt', type: 'top', price: 49, file: 'garments/oxford-shirt.svg' },
  { id: 'sundress-sage', name: 'Sage Sundress', type: 'dress', price: 68, file: 'garments/sundress-sage.svg' },
  { id: 'pleated-skirt', name: 'Pleated Midi Skirt', type: 'bottom', price: 52, file: 'garments/pleated-skirt.svg' },
  { id: 'jeans-indigo', name: 'Indigo Straight Jeans', type: 'bottom', price: 79, file: 'garments/jeans-indigo.svg' },
];

export const catalogUrl = (item) => new URL(item.file, document.baseURI).href;
