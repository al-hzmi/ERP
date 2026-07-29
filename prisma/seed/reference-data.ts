/**
 * Reference vocabulary for the data generator.
 *
 * Real Arabic and English names, real Saudi cities, real product categories.
 * Generated data that reads as "Product 1, Product 2" tests nothing about
 * bidirectional text rendering, column widths, or search relevance — the three
 * things most likely to be wrong in an Arabic-first interface.
 */

export const CITIES: readonly { ar: string; en: string }[] = [
  { ar: 'الرياض', en: 'Riyadh' },
  { ar: 'جدة', en: 'Jeddah' },
  { ar: 'الدمام', en: 'Dammam' },
  { ar: 'مكة المكرمة', en: 'Makkah' },
  { ar: 'المدينة المنورة', en: 'Madinah' },
  { ar: 'الخبر', en: 'Khobar' },
  { ar: 'أبها', en: 'Abha' },
  { ar: 'تبوك', en: 'Tabuk' },
  { ar: 'بريدة', en: 'Buraidah' },
  { ar: 'الطائف', en: 'Taif' },
];

export const MALE_FIRST_NAMES: readonly { ar: string; en: string }[] = [
  { ar: 'محمد', en: 'Mohammed' },
  { ar: 'عبدالله', en: 'Abdullah' },
  { ar: 'أحمد', en: 'Ahmed' },
  { ar: 'خالد', en: 'Khalid' },
  { ar: 'فهد', en: 'Fahad' },
  { ar: 'سلطان', en: 'Sultan' },
  { ar: 'يوسف', en: 'Yousef' },
  { ar: 'عمر', en: 'Omar' },
  { ar: 'سعود', en: 'Saud' },
  { ar: 'ماجد', en: 'Majed' },
  { ar: 'بندر', en: 'Bandar' },
  { ar: 'طارق', en: 'Tariq' },
  { ar: 'زياد', en: 'Ziad' },
  { ar: 'نايف', en: 'Naif' },
  { ar: 'مشعل', en: 'Mishal' },
];

export const FEMALE_FIRST_NAMES: readonly { ar: string; en: string }[] = [
  { ar: 'نورة', en: 'Noura' },
  { ar: 'سارة', en: 'Sarah' },
  { ar: 'فاطمة', en: 'Fatimah' },
  { ar: 'مريم', en: 'Maryam' },
  { ar: 'هند', en: 'Hind' },
  { ar: 'ريم', en: 'Reem' },
  { ar: 'لطيفة', en: 'Latifah' },
  { ar: 'منى', en: 'Mona' },
  { ar: 'أمل', en: 'Amal' },
  { ar: 'الجوهرة', en: 'Aljawharah' },
];

export const FAMILY_NAMES: readonly { ar: string; en: string }[] = [
  { ar: 'العتيبي', en: 'Alotaibi' },
  { ar: 'القحطاني', en: 'Alqahtani' },
  { ar: 'الغامدي', en: 'Alghamdi' },
  { ar: 'الحربي', en: 'Alharbi' },
  { ar: 'الشهري', en: 'Alshehri' },
  { ar: 'الدوسري', en: 'Aldosari' },
  { ar: 'الزهراني', en: 'Alzahrani' },
  { ar: 'المالكي', en: 'Almalki' },
  { ar: 'السبيعي', en: 'Alsubaie' },
  { ar: 'الرشيد', en: 'Alrashid' },
  { ar: 'العمري', en: 'Alamri' },
  { ar: 'الأنصاري', en: 'Alansari' },
  { ar: 'الجهني', en: 'Aljuhani' },
  { ar: 'البلوي', en: 'Albalawi' },
  { ar: 'الخالدي', en: 'Alkhalidi' },
];

export const COMPANY_PREFIXES: readonly { ar: string; en: string }[] = [
  { ar: 'شركة', en: 'Company' },
  { ar: 'مؤسسة', en: 'Establishment' },
  { ar: 'مجموعة', en: 'Group' },
];

export const COMPANY_NAMES: readonly { ar: string; en: string }[] = [
  { ar: 'الأفق', en: 'Alufuq' },
  { ar: 'النخبة', en: 'Alnukhba' },
  { ar: 'الرواد', en: 'Alruwad' },
  { ar: 'المستقبل', en: 'Almustaqbal' },
  { ar: 'الإتقان', en: 'Alitqan' },
  { ar: 'الواحة', en: 'Alwaha' },
  { ar: 'البيان', en: 'Albayan' },
  { ar: 'الصفوة', en: 'Alsafwa' },
  { ar: 'التقنية الحديثة', en: 'Modern Technology' },
  { ar: 'الخليج', en: 'Alkhaleej' },
  { ar: 'الجزيرة', en: 'Aljazeera' },
  { ar: 'المدار', en: 'Almadar' },
  { ar: 'النماء', en: 'Alnamaa' },
  { ar: 'الرياضة', en: 'Alriyada' },
  { ar: 'السحاب', en: 'Alsahab' },
  { ar: 'الفجر', en: 'Alfajr' },
  { ar: 'المرجان', en: 'Almarjan' },
  { ar: 'اللؤلؤة', en: 'Allulua' },
  { ar: 'الماسة', en: 'Almasa' },
  { ar: 'الابتكار', en: 'Alibtikar' },
];

export const COMPANY_SUFFIXES: readonly { ar: string; en: string }[] = [
  { ar: 'للتجارة', en: 'Trading' },
  { ar: 'للمقاولات', en: 'Contracting' },
  { ar: 'للتوريدات', en: 'Supplies' },
  { ar: 'للخدمات', en: 'Services' },
  { ar: 'للاستثمار', en: 'Investment' },
  { ar: 'للتوزيع', en: 'Distribution' },
];

/**
 * Product categories with their SKU prefix, price band and physical properties.
 *
 * The price bands are deliberately different by an order of magnitude across
 * categories. A dataset where everything costs between 90 and 110 riyals will
 * never surface a formatting bug in a column sized for four digits.
 */
export interface CategoryTemplate {
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string;
  /** SKU prefix, e.g. `BTC` -> `BTC-1001`. */
  readonly prefix: string;
  readonly minPrice: number;
  readonly maxPrice: number;
  /** Cost as a fraction of sale price — the category's gross margin profile. */
  readonly costRatio: number;
  readonly trackExpiry: boolean;
  readonly trackBatch: boolean;
  readonly trackSerial: boolean;
  readonly unitCode: string;
  readonly items: readonly { ar: string; en: string }[];
}

export const CATEGORY_TEMPLATES: readonly CategoryTemplate[] = [
  {
    code: 'BTC',
    nameAr: 'أجهزة إلكترونية',
    nameEn: 'Electronics',
    prefix: 'BTC',
    minPrice: 350,
    maxPrice: 9500,
    costRatio: 0.72,
    trackExpiry: false,
    trackBatch: false,
    trackSerial: true,
    unitCode: 'PCS',
    items: [
      { ar: 'حاسب محمول', en: 'Laptop' },
      { ar: 'شاشة عرض', en: 'Monitor' },
      { ar: 'طابعة ليزر', en: 'Laser Printer' },
      { ar: 'لوحة مفاتيح', en: 'Keyboard' },
      { ar: 'فأرة لاسلكية', en: 'Wireless Mouse' },
      { ar: 'جهاز لوحي', en: 'Tablet' },
      { ar: 'هاتف ذكي', en: 'Smartphone' },
      { ar: 'سماعات رأس', en: 'Headphones' },
      { ar: 'كاميرا مراقبة', en: 'Security Camera' },
      { ar: 'موجه شبكة', en: 'Network Router' },
    ],
  },
  {
    code: 'FOD',
    nameAr: 'مواد غذائية',
    nameEn: 'Food Products',
    prefix: 'FOD',
    minPrice: 5,
    maxPrice: 180,
    costRatio: 0.78,
    trackExpiry: true,
    trackBatch: true,
    trackSerial: false,
    unitCode: 'CTN',
    items: [
      { ar: 'أرز بسمتي', en: 'Basmati Rice' },
      { ar: 'زيت زيتون', en: 'Olive Oil' },
      { ar: 'تمر سكري', en: 'Sukkari Dates' },
      { ar: 'عسل طبيعي', en: 'Natural Honey' },
      { ar: 'قهوة عربية', en: 'Arabic Coffee' },
      { ar: 'شاي أخضر', en: 'Green Tea' },
      { ar: 'حليب مجفف', en: 'Powdered Milk' },
      { ar: 'سكر أبيض', en: 'White Sugar' },
      { ar: 'دقيق فاخر', en: 'Premium Flour' },
      { ar: 'معجون طماطم', en: 'Tomato Paste' },
    ],
  },
  {
    code: 'MED',
    nameAr: 'مستلزمات طبية',
    nameEn: 'Medical Supplies',
    prefix: 'MED',
    minPrice: 12,
    maxPrice: 2400,
    costRatio: 0.65,
    trackExpiry: true,
    trackBatch: true,
    trackSerial: false,
    unitCode: 'BOX',
    items: [
      { ar: 'كمامات طبية', en: 'Medical Masks' },
      { ar: 'قفازات معقمة', en: 'Sterile Gloves' },
      { ar: 'محاليل تعقيم', en: 'Sanitising Solution' },
      { ar: 'ضمادات طبية', en: 'Medical Bandages' },
      { ar: 'جهاز قياس ضغط', en: 'Blood Pressure Monitor' },
      { ar: 'ميزان حرارة رقمي', en: 'Digital Thermometer' },
      { ar: 'حقن طبية', en: 'Syringes' },
      { ar: 'شاش طبي', en: 'Medical Gauze' },
    ],
  },
  {
    code: 'CON',
    nameAr: 'مواد بناء',
    nameEn: 'Construction Materials',
    prefix: 'CON',
    minPrice: 18,
    maxPrice: 1600,
    costRatio: 0.82,
    trackExpiry: false,
    trackBatch: true,
    trackSerial: false,
    unitCode: 'TON',
    items: [
      { ar: 'أسمنت بورتلاندي', en: 'Portland Cement' },
      { ar: 'حديد تسليح', en: 'Steel Rebar' },
      { ar: 'رمل مغسول', en: 'Washed Sand' },
      { ar: 'بلاط سيراميك', en: 'Ceramic Tiles' },
      { ar: 'دهان أساس', en: 'Primer Paint' },
      { ar: 'عازل مائي', en: 'Waterproofing Membrane' },
      { ar: 'طوب أحمر', en: 'Red Brick' },
      { ar: 'خشب معالج', en: 'Treated Timber' },
    ],
  },
  {
    code: 'OFF',
    nameAr: 'قرطاسية ومكتبية',
    nameEn: 'Office Supplies',
    prefix: 'OFF',
    minPrice: 3,
    maxPrice: 450,
    costRatio: 0.70,
    trackExpiry: false,
    trackBatch: false,
    trackSerial: false,
    unitCode: 'PCS',
    items: [
      { ar: 'ورق تصوير A4', en: 'A4 Copy Paper' },
      { ar: 'أقلام حبر جاف', en: 'Ballpoint Pens' },
      { ar: 'ملفات بلاستيكية', en: 'Plastic Folders' },
      { ar: 'دباسة مكتبية', en: 'Office Stapler' },
      { ar: 'حبر طابعة', en: 'Printer Toner' },
      { ar: 'دفاتر ملاحظات', en: 'Notebooks' },
      { ar: 'لوح كتابة', en: 'Whiteboard' },
      { ar: 'آلة حاسبة', en: 'Calculator' },
    ],
  },
  {
    code: 'CHM',
    nameAr: 'مواد كيميائية',
    nameEn: 'Chemicals',
    prefix: 'CHM',
    minPrice: 25,
    maxPrice: 3200,
    costRatio: 0.68,
    trackExpiry: true,
    trackBatch: true,
    trackSerial: false,
    unitCode: 'LTR',
    items: [
      { ar: 'منظف صناعي', en: 'Industrial Cleaner' },
      { ar: 'مذيب عضوي', en: 'Organic Solvent' },
      { ar: 'حمض مخفف', en: 'Diluted Acid' },
      { ar: 'مادة لاصقة', en: 'Industrial Adhesive' },
      { ar: 'زيت تشحيم', en: 'Lubricating Oil' },
      { ar: 'مبيد حشري', en: 'Insecticide' },
    ],
  },
  {
    code: 'SRV',
    nameAr: 'خدمات',
    nameEn: 'Services',
    prefix: 'SRV',
    minPrice: 500,
    maxPrice: 45000,
    costRatio: 0.45,
    trackExpiry: false,
    trackBatch: false,
    trackSerial: false,
    unitCode: 'SRV',
    items: [
      { ar: 'عقد صيانة سنوي', en: 'Annual Maintenance Contract' },
      { ar: 'استشارات تقنية', en: 'Technical Consulting' },
      { ar: 'تركيب وتشغيل', en: 'Installation and Commissioning' },
      { ar: 'تدريب الموظفين', en: 'Staff Training' },
      { ar: 'خدمات النقل', en: 'Transportation Services' },
    ],
  },
];

export const BRANDS: readonly { ar: string; en: string }[] = [
  { ar: 'الرائد', en: 'Alraed' },
  { ar: 'المتميز', en: 'Almutamayez' },
  { ar: 'الجودة', en: 'Aljawda' },
  { ar: 'النخيل', en: 'Alnakheel' },
  { ar: 'الصقر', en: 'Alsaqr' },
  { ar: 'الوفاء', en: 'Alwafa' },
  { ar: 'المهند', en: 'Almuhannad' },
  { ar: 'التميمة', en: 'Altamima' },
];

export const UNITS_OF_MEASURE: readonly {
  code: string;
  ar: string;
  en: string;
  baseFactor: string;
}[] = [
  { code: 'PCS', ar: 'قطعة', en: 'Piece', baseFactor: '1' },
  { code: 'BOX', ar: 'علبة', en: 'Box', baseFactor: '12' },
  { code: 'CTN', ar: 'كرتون', en: 'Carton', baseFactor: '24' },
  { code: 'KG', ar: 'كيلوجرام', en: 'Kilogram', baseFactor: '1' },
  { code: 'TON', ar: 'طن', en: 'Ton', baseFactor: '1000' },
  { code: 'LTR', ar: 'لتر', en: 'Litre', baseFactor: '1' },
  { code: 'MTR', ar: 'متر', en: 'Metre', baseFactor: '1' },
  { code: 'SRV', ar: 'خدمة', en: 'Service', baseFactor: '1' },
];

export const DEPARTMENTS: readonly { code: string; ar: string; en: string }[] = [
  { code: 'MGT', ar: 'الإدارة العليا', en: 'Executive Management' },
  { code: 'FIN', ar: 'الشؤون المالية', en: 'Finance' },
  { code: 'SLS', ar: 'المبيعات', en: 'Sales' },
  { code: 'PRC', ar: 'المشتريات', en: 'Procurement' },
  { code: 'WHS', ar: 'المستودعات', en: 'Warehousing' },
  { code: 'HRD', ar: 'الموارد البشرية', en: 'Human Resources' },
  { code: 'ITD', ar: 'تقنية المعلومات', en: 'Information Technology' },
];

export const JOB_TITLES: readonly { ar: string; en: string; departmentCode: string; minSalary: number; maxSalary: number }[] = [
  { ar: 'المدير التنفيذي', en: 'Chief Executive Officer', departmentCode: 'MGT', minSalary: 45000, maxSalary: 65000 },
  { ar: 'المدير المالي', en: 'Chief Financial Officer', departmentCode: 'FIN', minSalary: 32000, maxSalary: 48000 },
  { ar: 'محاسب أول', en: 'Senior Accountant', departmentCode: 'FIN', minSalary: 12000, maxSalary: 18000 },
  { ar: 'محاسب', en: 'Accountant', departmentCode: 'FIN', minSalary: 7000, maxSalary: 11000 },
  { ar: 'مدير المبيعات', en: 'Sales Manager', departmentCode: 'SLS', minSalary: 18000, maxSalary: 26000 },
  { ar: 'مندوب مبيعات', en: 'Sales Representative', departmentCode: 'SLS', minSalary: 5500, maxSalary: 9000 },
  { ar: 'مدير المشتريات', en: 'Procurement Manager', departmentCode: 'PRC', minSalary: 16000, maxSalary: 23000 },
  { ar: 'أخصائي مشتريات', en: 'Procurement Specialist', departmentCode: 'PRC', minSalary: 7500, maxSalary: 12000 },
  { ar: 'أمين مستودع', en: 'Warehouse Keeper', departmentCode: 'WHS', minSalary: 4500, maxSalary: 7500 },
  { ar: 'مشرف مستودعات', en: 'Warehouse Supervisor', departmentCode: 'WHS', minSalary: 9000, maxSalary: 14000 },
  { ar: 'مدير الموارد البشرية', en: 'HR Manager', departmentCode: 'HRD', minSalary: 15000, maxSalary: 22000 },
  { ar: 'أخصائي موارد بشرية', en: 'HR Specialist', departmentCode: 'HRD', minSalary: 6500, maxSalary: 10500 },
  { ar: 'مهندس نظم', en: 'Systems Engineer', departmentCode: 'ITD', minSalary: 11000, maxSalary: 17000 },
  { ar: 'مطور برمجيات', en: 'Software Developer', departmentCode: 'ITD', minSalary: 10000, maxSalary: 16000 },
];

export const ALLOWANCE_TYPES: readonly { code: string; ar: string; en: string; ratio: number }[] = [
  { code: 'HOUSING', ar: 'بدل سكن', en: 'Housing Allowance', ratio: 0.25 },
  { code: 'TRANSPORT', ar: 'بدل نقل', en: 'Transport Allowance', ratio: 0.10 },
  { code: 'PHONE', ar: 'بدل اتصالات', en: 'Communication Allowance', ratio: 0.03 },
];

export const DEDUCTION_TYPES: readonly { code: string; ar: string; en: string; ratio: number }[] = [
  { code: 'GOSI', ar: 'التأمينات الاجتماعية', en: 'GOSI Contribution', ratio: 0.0975 },
  { code: 'LOAN', ar: 'سلفة موظف', en: 'Employee Loan', ratio: 0.05 },
];

export const BRANCH_TEMPLATES: readonly {
  code: string;
  ar: string;
  en: string;
  cityIndex: number;
  warehouses: readonly { code: string; ar: string; en: string }[];
}[] = [
  {
    code: 'BR01',
    ar: 'الفرع الرئيسي - الرياض',
    en: 'Head Office - Riyadh',
    cityIndex: 0,
    warehouses: [
      { code: 'WH01', ar: 'المستودع الرئيسي', en: 'Main Warehouse' },
      { code: 'WH02', ar: 'مستودع التوزيع', en: 'Distribution Warehouse' },
      { code: 'WH03', ar: 'مستودع الحجر', en: 'Quarantine Warehouse' },
    ],
  },
  {
    code: 'BR02',
    ar: 'فرع جدة',
    en: 'Jeddah Branch',
    cityIndex: 1,
    warehouses: [
      { code: 'WH04', ar: 'مستودع جدة الرئيسي', en: 'Jeddah Main Warehouse' },
      { code: 'WH05', ar: 'مستودع الميناء', en: 'Port Warehouse' },
    ],
  },
  {
    code: 'BR03',
    ar: 'فرع الدمام',
    en: 'Dammam Branch',
    cityIndex: 2,
    warehouses: [
      { code: 'WH06', ar: 'مستودع الدمام', en: 'Dammam Warehouse' },
      { code: 'WH07', ar: 'مستودع المنطقة الصناعية', en: 'Industrial Area Warehouse' },
    ],
  },
  {
    code: 'BR04',
    ar: 'فرع مكة المكرمة',
    en: 'Makkah Branch',
    cityIndex: 3,
    warehouses: [
      { code: 'WH08', ar: 'مستودع مكة', en: 'Makkah Warehouse' },
      { code: 'WH09', ar: 'مستودع العزيزية', en: 'Aziziyah Warehouse' },
    ],
  },
  {
    code: 'BR05',
    ar: 'فرع أبها',
    en: 'Abha Branch',
    cityIndex: 6,
    warehouses: [{ code: 'WH10', ar: 'مستودع أبها', en: 'Abha Warehouse' }],
  },
];

export const COST_CENTERS: readonly { code: string; ar: string; en: string }[] = [
  { code: 'CC-ADM', ar: 'الإدارة', en: 'Administration' },
  { code: 'CC-SLS', ar: 'المبيعات', en: 'Sales' },
  { code: 'CC-OPS', ar: 'العمليات', en: 'Operations' },
  { code: 'CC-LOG', ar: 'اللوجستيات', en: 'Logistics' },
];

export const PROJECTS: readonly { code: string; ar: string; en: string; budget: number }[] = [
  { code: 'PRJ-001', ar: 'مشروع التوسع الشمالي', en: 'Northern Expansion', budget: 2_500_000 },
  { code: 'PRJ-002', ar: 'تحديث البنية التقنية', en: 'IT Infrastructure Upgrade', budget: 850_000 },
  { code: 'PRJ-003', ar: 'برنامج كفاءة المستودعات', en: 'Warehouse Efficiency Programme', budget: 1_200_000 },
];

export const JOURNAL_DESCRIPTIONS: readonly { ar: string; en: string }[] = [
  { ar: 'قيد مصروفات إيجار المكاتب', en: 'Office rent expense' },
  { ar: 'قيد مصروفات الكهرباء والماء', en: 'Utilities expense' },
  { ar: 'قيد مصروفات الاتصالات', en: 'Communications expense' },
  { ar: 'قيد مصروفات الصيانة', en: 'Maintenance expense' },
  { ar: 'قيد مصروفات التسويق والإعلان', en: 'Marketing and advertising expense' },
  { ar: 'قيد مصروفات السفر', en: 'Travel expense' },
  { ar: 'قيد مصروفات التأمين', en: 'Insurance expense' },
  { ar: 'قيد مصروفات الرسوم الحكومية', en: 'Government fees' },
  { ar: 'قيد تسوية محاسبية', en: 'Accounting adjustment' },
  { ar: 'قيد مصروفات نظافة وأمن', en: 'Cleaning and security expense' },
];
