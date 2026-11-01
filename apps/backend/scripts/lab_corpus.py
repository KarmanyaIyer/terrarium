"""Built-in texts for the Neuron Lab.

FIELD_GUIDE: short, varied sentences. Calibration runs them through the model to learn each neuron's typical range
and the residual norms that set the dose unit; neuron cards show the ones a neuron fires on most. Change the list and
CORPUS_VERSION together: calibration results are cached per model and version.
"""

CORPUS_VERSION = 1

FIELD_GUIDE = [
    # animals and nature
    "A barn owl swooped silently over the field at midnight.",
    "The cat stretched in the sun and then curled up on the windowsill.",
    "Our dog barks at the mail carrier every single morning.",
    "A herd of elephants walked slowly toward the watering hole.",
    "Bees carry pollen from flower to flower as they collect nectar.",
    "The wolf pack howled at the full moon from the ridge.",
    "Dolphins leapt beside the boat as it crossed the bay.",
    "Autumn leaves turned red and gold before they fell.",
    "A thunderstorm rolled in from the west and flooded the streets.",
    "The desert was silent except for the wind over the dunes.",
    "Snow covered the pine forest and muffled every sound.",
    "Coral reefs are home to thousands of species of fish.",
    # food and home
    "She chopped the onions, browned the garlic and added the tomatoes.",
    "Fresh bread was cooling on the kitchen counter.",
    "Add two cups of flour and a pinch of salt, then knead the dough.",
    "The coffee was strong, black and far too hot to drink.",
    "We ordered sushi, ramen and a plate of dumplings to share.",
    "He washed the dishes and wiped down the table after dinner.",
    # science, math, tech
    "Water boils at one hundred degrees Celsius at sea level.",
    "The derivative of x squared is two x.",
    "Seventeen plus twenty-five equals forty-two.",
    "If a train travels 60 miles in 1.5 hours, its average speed is 40 miles per hour.",
    "Photosynthesis turns sunlight, water and carbon dioxide into sugar and oxygen.",
    "The mitochondria produce most of the cell's energy.",
    "Black holes bend light so strongly that nothing escapes their event horizon.",
    "Jupiter is the largest planet in our solar system.",
    "The server returned a 404 error because the page did not exist.",
    "Restart the router, then check whether the light turns green.",
    "def add(a, b):\n    return a + b",
    "for i in range(10):\n    print(i * i)",
    "SELECT name, email FROM users WHERE active = 1 ORDER BY name;",
    "const total = items.reduce((sum, x) => sum + x.price, 0);",
    "git commit -m \"fix the login bug\" && git push origin main",
    # people, history, society
    "The treaty was signed in 1648 and ended thirty years of war.",
    "The Roman Empire built roads that stretched across Europe.",
    "The court ruled that the contract was void.",
    "Pursuant to section 4, the tenant shall pay rent on the first day of each month.",
    "The patient was given ibuprofen for the swelling in her knee.",
    "Wash your hands for at least twenty seconds with soap and water.",
    "The election results will be announced tomorrow morning.",
    "The company reported record profits in the third quarter.",
    "Stocks fell sharply after the central bank raised interest rates.",
    "The team scored in the final minute and won the championship.",
    "She ran the marathon in just under three hours.",
    # arts and language
    "The orchestra tuned their instruments before the symphony began.",
    "He strummed a few chords on his old guitar.",
    "Shall I compare thee to a summer's day? Thou art more lovely and more temperate.",
    "Roses are red, violets are blue, sugar is sweet, and so are you.",
    "Once upon a time, a young fox lived at the edge of a great forest.",
    "The detective examined the footprints by the broken window.",
    "The spaceship drifted past the rings of a distant planet.",
    "The knight drew his sword and faced the dragon.",
    "Ahoy, matey! Hoist the sails and bring me the treasure map!",
    "Yo, that party last night was absolutely wild, no cap.",
    "Dear Sir or Madam, I am writing to apply for the position of analyst.",
    "Thanks so much for your help, I really appreciate it!",
    # feelings
    "I'm so happy today, everything feels bright and wonderful!",
    "She cried alone in her room after hearing the news.",
    "He was furious and slammed the door behind him.",
    "My heart pounded with fear as the footsteps came closer.",
    "I feel calm and peaceful sitting by the lake.",
    "I'm worried I won't finish the project in time.",
    "We laughed until our stomachs hurt.",
    "Grief came in waves for months after she was gone.",
    # assistant talk
    "Sure! Here is a short summary of the article.",
    "As an AI language model, I don't have personal opinions.",
    "I'm sorry, but I can't help with that request.",
    "Great question! Let me explain step by step.",
    "I am Qwen, a large language model created to be a helpful assistant.",
    "Is there anything else I can help you with today?",
    "User: What is the capital of France?\nAssistant: The capital of France is Paris.",
    # places and travel
    "Paris is famous for the Eiffel Tower and its cafes.",
    "We took the train from Tokyo to Kyoto to see the temples.",
    "The Golden Gate Bridge was covered in fog this morning.",
    "New York City never sleeps; the subway runs all night.",
    "They hiked to the top of the mountain and watched the sunrise.",
    "The flight to Sydney was delayed by three hours.",
    # religion, philosophy, time
    "The monks meditated in silence before dawn.",
    "To be or not to be, that is the question.",
    "Every day is a fresh start.",
    "The meeting is scheduled for 3:30 pm on Tuesday, March 4th.",
    "In 2024 the population of the city reached two million.",
    # other languages
    "Le chat dort sur le canapé pendant que la pluie tombe.",
    "Je voudrais un café et un croissant, s'il vous plaît.",
    "El perro corre por el parque con su pelota roja.",
    "Mañana vamos a la playa con nuestros amigos.",
    "Die Katze sitzt auf dem Dach und beobachtet die Vögel.",
    "Ich habe heute keine Zeit, aber morgen gern.",
    "今天天气很好，我们去公园散步吧。",
    "東京は日本の首都です。",
    "Привет, как у тебя дела?",
    "Il sole tramonta dietro le colline toscane.",
    # odd forms
    "1, 2, 3, 4, 5, 6, 7, 8, 9, 10",
    "https://www.example.com/index.html?page=2",
    "WARNING: disk space is running low on /dev/sda1",
    "!!! BREAKING NEWS !!! Volcano erupts on remote island",
    "lol ok see u tmrw :)",
    "The quick brown fox jumps over the lazy dog.",
]


def calibration_texts(group: int = 4) -> list[str]:
    """The field guide joined into short paragraphs, so later tokens have some context."""
    return [" ".join(FIELD_GUIDE[i : i + group]) for i in range(0, len(FIELD_GUIDE), group)]
