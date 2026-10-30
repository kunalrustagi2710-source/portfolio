// Plot Twist — Party mode prompt bank and mode metadata (no secrets here; Mystery content lives server-side).
window.PT_CONTENT = {
  modes: {
    adventure: {
      name: 'Adventure', icon: '🧭', cls: 'c-adv', btn: 'mint',
      tag: 'Hidden roles · scan to twist',
      blurb: 'Secret Twisters spread through the room by scanning badges. Explorers get one shot to unmask them.'
    },
    mystery: {
      name: 'Mystery', icon: '🔍', cls: 'c-mys', btn: 'violet',
      tag: '3 clues · 1 final code',
      blurb: 'Everyone holds different pieces of three clues. Talk it out, crack each digit, then open the lock together.'
    },
    party: {
      name: 'Party', icon: '🎉', cls: 'c-par', btn: 'primary',
      tag: '5 rounds · match the room',
      blurb: 'Answer fast and think like the group. Every player who matches your answer earns you Sparks.'
    }
  },
  party: {
    wyr: [
      ['Would you rather…', ['Eat only Maggi forever', 'Never eat Maggi again']],
      ['Would you rather…', ['Unlimited free flights', 'Unlimited free food delivery']],
      ['Would you rather…', ['Always be 10 minutes early', 'Always be 20 minutes late']],
      ['Would you rather…', ['Talk only in voice notes', 'Talk only in emojis']],
      ['Would you rather…', ['Be famous on Instagram', 'Be rich but totally unknown']],
      ['Would you rather…', ['Relive your best day', 'Skip your worst day']],
      ['Would you rather…', ['Read everyone\'s mind for a day', 'Be invisible for a day']],
      ['Would you rather…', ['Give up your phone for a week', 'Give up chai for a month']]
    ],
    vibe: [
      ['Perfect Sunday plan?', ['Sleep till noon', 'Road trip', 'Binge a series', 'Brunch with the gang']],
      ['Best partner for chai?', ['Samosa', 'Parle-G', 'Pakoras', 'Pure gossip']],
      ['Your role on a group trip?', ['The planner', 'The DJ', 'The photographer', 'The one who\'s late']],
      ['Superpower for exam week?', ['Photographic memory', 'Freeze time', 'Read the examiner\'s mind', 'Never need sleep']],
      ['Ultimate comfort food?', ['Rajma chawal', 'Butter chicken', 'Pizza', 'Momos']],
      ['Dream holiday?', ['Goa beaches', 'Ladakh road trip', 'Bali', 'Swiss Alps']],
      ['Best way to spend ₹10,000?', ['Concert tickets', 'New sneakers', 'A weekend trip', 'Save it']],
      ['The group chat needs…', ['More memes', 'Fewer voice notes', 'An actual plan', 'Less drama']]
    ],
    likely: [
      'Who\'s most likely to become a CEO?',
      'Who\'s most likely to cry at a movie?',
      'Who\'s most likely to forget their own birthday?',
      'Who\'s most likely to survive a zombie apocalypse?',
      'Who\'s most likely to go viral?',
      'Who\'s most likely to reply "k" to a long message?',
      'Who\'s most likely to start a business in college?',
      'Who\'s most likely to be late to their own wedding?',
      'Who\'s most likely to talk their way out of trouble?'
    ]
  }
};
