/* ===================== FORMULA ENGINE (safe expression evaluator) =====================
   هدف: اجرای امن فرمول‌های قابل‌تنظیم توسط مدیر، بدون استفاده از eval() یا Function().

   متغیرها (حروف لاتین):
     L  — مبلغ وام (Loan)
     N  — تعداد کل اقساط (Number of installments)
     I  — شماره قسط فعلی، از ۱ (Installment number) — i کوچک هم پشتیبانی می‌شود
     R  — مانده وام قبل از این قسط (Remaining)
     P  — مبلغ قابل دریافت / قدرت خرید (Purchasable) — فقط در فرمول معکوس
     c.X — هر ثابتی که مدیر تعریف کرده (با پیشوند c.)

   سینتکس ویژه:
     4%      → معادل 4/100 = 0.04  (درصد، فقط بعد از عدد)
     L * 4%  → معادل L * 0.04
     Math_round(x)  → گرد کردن به نزدیک‌ترین عدد صحیح
     Math_ceil(x)   → سقف (بالا گرد)
     Math_floor(x)  → کف (پایین گرد)

   عملیات مجاز: + - * / و پرانتز. (% بعد از عدد = درصد، بین دو مقدار = باقیمانده)
======================================================================================== */

(function () {
  // تبدیل اعداد فارسی/عربی به انگلیسی
  function toEnglishDigits(s) {
    if (!s) return '';
    return String(s)
      .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
      .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
  }

  // توابع ریاضی مجاز
  const MATH_FUNCS = {
    'Math_round': Math.round,
    'Math_ceil': Math.ceil,
    'Math_floor': Math.floor,
    // نام‌های کوتاه‌تر هم پشتیبانی می‌شوند
    'round': Math.round,
    'ceil': Math.ceil,
    'floor': Math.floor
  };

  // توکنایزر
  function tokenize(expr) {
    const tokens = [];
    let i = 0;
    const s = toEnglishDigits(String(expr || '')).trim();
    if (!s) throw new FormulaError('فرمول خالی است.');
    while (i < s.length) {
      const ch = s[i];
      // فضای خالی
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
      // عدد: رقم یا نقطه اعشار
      if (/[0-9.]/.test(ch)) {
        let num = '';
        let dotCount = 0;
        while (i < s.length && /[0-9.]/.test(s[i])) {
          if (s[i] === '.') { dotCount++; if (dotCount > 1) throw new FormulaError('عدد با دو نقطه اعشار نامعتبر است.'); }
          num += s[i]; i++;
        }
        if (num === '.' || num === '') throw new FormulaError('عدد نامعتبر: «' + num + '»');
        let value = parseFloat(num);
        // پشتیبانی از درصد: 4% → 0.04 (فقط وقتی % بلافاصله بعد از عدد بیاید)
        if (s[i] === '%') {
          value = value / 100;
          i++; // مصرف %
        }
        tokens.push({ type: 'num', value });
        continue;
      }
      // شناسه یا تابع: حرف یا زیرخط شروع می‌شود
      if (/[a-zA-Z_]/.test(ch)) {
        let id = '';
        while (i < s.length && /[a-zA-Z0-9_]/.test(s[i])) { id += s[i]; i++; }
        // پشتیبانی از c.name (دسترسی به ثابت‌ها)
        if (s[i] === '.') {
          // بررسی اینکه آیا بعد از نقطه یک حرف می‌آید (property access) یا نه
          // فقط اگر c. باشد property access است، در غیر این صورت نقطه عملگر نیست
          if (id === 'c' && i + 1 < s.length && /[a-zA-Z_]/.test(s[i + 1])) {
            id += '.';
            i++;
            let prop = '';
            while (i < s.length && /[a-zA-Z0-9_]/.test(s[i])) { prop += s[i]; i++; }
            if (!prop) throw new FormulaError('نام ثابت بعد از نقطه خالی است.');
            id += prop;
          }
        }
        // بررسی اینکه آیا این یک تابع است (identifier بعد از آن پرانتز باز می‌آید)
        // فضای خالی بین نام تابع و پرانتز مجاز نیست
        let j = i;
        if (j < s.length && s[j] === '(') {
          tokens.push({ type: 'func', value: id });
        } else {
          tokens.push({ type: 'ident', value: id });
        }
        continue;
      }
      // عملگرها
      if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '%') {
        tokens.push({ type: 'op', value: ch }); i++; continue;
      }
      // پرانتز
      if (ch === '(') { tokens.push({ type: 'lparen' }); i++; continue; }
      if (ch === ')') { tokens.push({ type: 'rparen' }); i++; continue; }
      throw new FormulaError('کاراکتر نامعتبر در فرمول: «' + ch + '»');
    }
    return tokens;
  }

  // تقدم عملگرها
  const PRECEDENCE = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2 };
  const RIGHT_ASSOC = false;

  // تبدیل infix به postfix (shunting-yard) با پشتیبانی از توابع
  function toPostfix(tokens) {
    const output = [];
    const ops = [];
    let prev = null;
    for (let idx = 0; idx < tokens.length; idx++) {
      const t = tokens[idx];
      if (t.type === 'num' || t.type === 'ident') {
        output.push(t);
      } else if (t.type === 'func') {
        ops.push(t);
      } else if (t.type === 'op') {
        const isUnary = (t.value === '-' || t.value === '+') &&
          (prev === null || prev.type === 'op' || prev.type === 'lparen');
        if (isUnary) {
          if (t.value === '-') ops.push({ type: 'op', value: 'u-' });
        } else {
          while (ops.length && ops[ops.length - 1].type === 'op' && ops[ops.length - 1].value !== 'u-') {
            const top = ops[ops.length - 1];
            const topPrec = PRECEDENCE[top.value];
            const curPrec = PRECEDENCE[t.value];
            if (topPrec > curPrec || (topPrec === curPrec && !RIGHT_ASSOC)) {
              output.push(ops.pop());
            } else break;
          }
          ops.push(t);
        }
      } else if (t.type === 'lparen') {
        ops.push(t);
      } else if (t.type === 'rparen') {
        let found = false;
        while (ops.length) {
          const top = ops.pop();
          if (top.type === 'lparen') { found = true; break; }
          output.push(top);
        }
        if (!found) throw new FormulaError('پرانتز بسته بدون پرانتز باز متناظر.');
        // اگر بعد از ( یک تابع هست، آن را به خروجی ببر
        if (ops.length && ops[ops.length - 1].type === 'func') {
          output.push(ops.pop());
        }
      }
      prev = t;
    }
    while (ops.length) {
      const top = ops.pop();
      if (top.type === 'lparen') throw new FormulaError('پرانتز باز بسته نشده است.');
      output.push(top);
    }
    return output;
  }

  // نگاشت نام‌های قدیمی به کوتاه (backward compat)
  const VAR_ALIASES = {
    loanAmount: 'L', remainingBalance: 'R', installmentsCount: 'N',
    installmentNumber: 'I', paidCount: 'paid', paidPrincipal: 'paidP',
    purchasableAmount: 'P'
  };

  // ارزیابی postfix
  function evalPostfix(postfix, vars) {
    const stack = [];
    for (const t of postfix) {
      if (t.type === 'num') {
        stack.push(t.value);
      } else if (t.type === 'ident') {
        const v = lookupVar(t.value, vars);
        if (v === undefined || v === null || (typeof v !== 'number' && !isFinite(v))) {
          throw new FormulaError('متغیر «' + t.value + '» تعریف نشده یا عدد نیست.');
        }
        stack.push(Number(v));
      } else if (t.type === 'func') {
        const fn = MATH_FUNCS[t.value];
        if (!fn) throw new FormulaError('تابع «' + t.value + '» پشتیبانی نمی‌شود.');
        const a = stack.pop();
        if (a === undefined) throw new FormulaError('تابع «' + t.value + '» بدون آرگومان است.');
        const r = fn(Number(a));
        if (!isFinite(r)) throw new FormulaError('نتیجه تابع «' + t.value + '» نامتناهی است.');
        stack.push(r);
      } else if (t.type === 'op') {
        if (t.value === 'u-') {
          const a = stack.pop();
          if (a === undefined) throw new FormulaError('خطای نحسی در فرمول (عملگر unary بدون عملوند).');
          stack.push(-a);
          continue;
        }
        const b = stack.pop();
        const a = stack.pop();
        if (a === undefined || b === undefined) throw new FormulaError('خطای نحوی در فرمول (عملگر بدون عملوند کافی).');
        let r;
        switch (t.value) {
          case '+': r = a + b; break;
          case '-': r = a - b; break;
          case '*': r = a * b; break;
          case '/':
            if (b === 0) throw new FormulaError('تقسیم بر صفر در فرمول.');
            r = a / b; break;
          case '%':
            if (b === 0) throw new FormulaError('باقیمانده بر صفر در فرمول.');
            r = a % b; break;
          default: throw new FormulaError('عملگر ناشناخته: ' + t.value);
        }
        if (!isFinite(r)) throw new FormulaError('نتیجه محاسبه نامتناهی است.');
        stack.push(r);
      }
    }
    if (stack.length !== 1) throw new FormulaError('فرمول ناقص است - بیش از یک مقدار باقی مانده.');
    const result = stack[0];
    if (typeof result !== 'number' || !isFinite(result)) throw new FormulaError('نتیجه فرمول عدد نیست.');
    return result;
  }

  // جستجوی متغیر
  function lookupVar(name, vars) {
    if (name === 'c') return undefined;
    if (name.startsWith('c.')) {
      const c = vars && vars.c;
      if (!c || typeof c !== 'object') return undefined;
      const key = name.slice(2);
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) return undefined;
      return Object.prototype.hasOwnProperty.call(c, key) ? c[key] : undefined;
    }
    // alias: نام‌های قدیمی به کوتاه
    const resolved = VAR_ALIASES[name] || name;
    if (Object.prototype.hasOwnProperty.call(vars, resolved)) return vars[resolved];
    if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
    return undefined;
  }

  function FormulaError(msg) {
    this.name = 'FormulaError';
    this.message = msg;
  }
  FormulaError.prototype = Object.create(Error.prototype);

  function evalFormula(expr, vars) {
    vars = vars || {};
    const tokens = tokenize(expr);
    const postfix = toPostfix(tokens);
    return evalPostfix(postfix, vars);
  }

  function validateFormula(expr, knownVars) {
    try {
      const sampleVars = Object.assign({
        L: 100000000, R: 50000000, N: 24, I: 13, i: 13,
        paid: 12, paidP: 50000000, P: 60000000,
        c: knownVars && knownVars.c ? knownVars.c : {}
      }, knownVars || {});
      const result = evalFormula(expr, sampleVars);
      return { ok: true, sample: result };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }

  window.FormulaEngine = {
    eval: evalFormula,
    validate: validateFormula,
    FormulaError: FormulaError
  };
})();
