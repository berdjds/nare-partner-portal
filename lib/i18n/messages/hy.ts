/**
 * Armenian catalogue for the public chrome, the sign-in page and the partner landing.
 * Written as a first pass for these short UI labels; a native speaker must review before
 * the owner treats it as approved (see doc/b2b-cycle-1/PHASE-4.md). Keys it lacks fall back to
 * English, and tests fail the build if any English key is missing here.
 */
import type { MessageKey } from "./en";

export const hy: Record<MessageKey, string> = {
  "common.brand": "Nare Travel and Tours",
  "common.signIn": "Մուտք",
  "lang.label": "Լեզու",
  "nav.home": "Գլխավոր",
  "nav.apply": "Դառնալ գործընկեր",
  "nav.primary": "Հիմնական մենյու",
  "nav.openMenu": "Բացել մենյուն",
  "nav.closeMenu": "Փակել մենյուն",
  "login.headline": "Բարի վերադարձ գործընկերների պորտալ",
  "login.bullet1": "Ուղարկեք և կառավարեք ձեր բոլոր ճանապարհորդական հարցումները մեկ վայրում։",
  "login.bullet2": "Յուրաքանչյուր հարցում ստուգվում է Nare թիմի կողմից։",
  "login.bullet3": "Հետևեք յուրաքանչյուր հարցմանը հստակ և տեսանելի կարգավիճակով։",
  "login.title": "Մուտք գործընկերների պորտալ",
  "login.subtitle": "Օգտագործեք Nare թիմի տրամադրած հաշիվը։",
  "login.email": "Էլ. փոստ",
  "login.emailPlaceholder": "you@example.com",
  "login.password": "Գաղտնաբառ",
  "login.showPassword": "Ցույց տալ գաղտնաբառը",
  "login.hidePassword": "Թաքցնել գաղտնաբառը",
  "login.capsLock": "Caps Lock-ը միացված է։",
  "login.submit": "Մուտք",
  "login.submitting": "Մուտք է կատարվում...",
  "login.forgot": "Մոռացե՞լ եք գաղտնաբառը",
  "login.error": "Էլ. փոստը կամ գաղտնաբառը սխալ է։",
  "footer.terms": "Օգտագործման պայմաններ",
  "footer.privacy": "Գաղտնիություն",
  "footer.legalNav": "Իրավական տեղեկություններ",
  "footer.rights": "© {year} {name}։ Բոլոր իրավունքները պաշտպանված են։ Մշակող՝ Hayk FZC",
  "partner.title": "Իմ առաջարկները",
  "partner.subtitle": "{agency} գործակալության հարցումները և տրված առաջարկները։",
  "partner.empty": "Հարցումներ դեռ չկան։",
  "partner.notIssued": "Առաջարկը դեռ չի տրվել։",
  "partner.messages": "Ձեր հաղորդագրությունները և նշումները՝ ",
  "partner.quotation": "Առաջարկ v{version} (PDF)",
};
