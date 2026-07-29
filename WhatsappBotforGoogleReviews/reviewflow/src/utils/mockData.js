const { SENTIMENTS, STATES } = require("../config/constants");

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

const NAMES = [
  "Rohit Verma", "Priya Sharma", "Amit Kumar", "Sneha Patil", "Vikram Singh",
  "Anjali Gupta", "Rahul Mehta", "Divya Nair", "Karan Joshi", "Pooja Iyer",
  "Arjun Rao", "Neha Kapoor",
];

const MOCK_RECORDS = NAMES.map((name, i) => {
  const sentiment = i % 3 === 0 ? SENTIMENTS.SAD : i % 3 === 1 ? SENTIMENTS.NEUTRAL : SENTIMENTS.HAPPY;
  const state = sentiment === SENTIMENTS.SAD ? STATES.AWAITING_FEEDBACK_CHOICE : STATES.COMPLETED;
  return {
    id: `mock_${i + 1}`,
    createdAt: daysAgo(i % 7),
    phone: `+9174xxxxxx${String(10 + i).padStart(2, "0")}`,
    customerName: name,
    sentiment,
    state,
    reviewText:
      sentiment === SENTIMENTS.HAPPY
        ? "Loved the service, will visit again! Staff was friendly and quick."
        : null,
    feedbackText:
      sentiment === SENTIMENTS.SAD ? "Order took too long and coffee was cold." : null,
    triggerSource: "mock_seed",
  };
});

module.exports = { MOCK_RECORDS };
