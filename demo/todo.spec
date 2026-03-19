Todo Manage System:

Goal:
  Manage personal todos.

Environment:
  Frontend: React + Ant Design
  Backend: Flask
  Data: In-memory

Theme:
  primaryColor = #1970FF
  fontSize = 14px

---

Entity Todo:
  id: string (primary)
  title: string (required, maxLength=100)
  completed: boolean (default=false)

---

Action CreateTodo:
  API POST /api/v1/createTodo

  Input:
    title

  Do:
    insert Todo:
      title = input.title
      completed = false

  Return:
    success
    id

  OnError:
    showMessage("Create failed")

---

Action SearchTodos:
  API GET /api/v1/todoList

  Input:
    searchKey = "" (optional)
    page
    pageSize

  Do:
    query Todo:
      where completed = false
      and title contains searchKey

    paginate by page, pageSize

  Return:
    data: Todo[]
    total

---

Action CompleteTodo:
  API POST /api/v1/completeTodo

  Input:
    id

  Do:
    update Todo:
      where id = input.id
      set completed = true

  Return:
    success

---

Page TodoPage (/todos):

  Header:
    text("📒 DEMO TODO MANAGE", align=center)

  Content:

    Section ActionBar:
      layout: flex(space-between)

      Left:
        input(searchKey)
        button("Search"):
          onClick:
            dispatch SearchTodos
            refresh todos

      Right:
        button("Add Todo", primary):
          onClick:
            openModal CreateTodoModal

    Section List:
      table(todos):
        columns:
          id
          title
          action:
            button("Complete"):
              onClick:
                dispatch CompleteTodo(id = row.id)
                refresh todos

  Footer:
    text("This is a footer", align=center)

---

Component CreateTodoModal:

  modal("Create Todo"):

    form:
      field title (input, required)

    onSubmit:
      dispatch CreateTodo(title = form.title)
      refresh todos
      closeModal

---

State:

  todos:
    source: SearchTodos
    autoLoad: true
    page = 1
    pageSize = 10